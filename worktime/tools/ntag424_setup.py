#!/usr/bin/env python3
"""
NTAG 424 DNA 출퇴근 태그 설정 도구 (USB NFC 리더기 + PC 필요)

  python ntag424_setup.py genkeys                      # 1회: 비밀키 생성 -> keys.json
  python ntag424_setup.py program --base URL --action START
  python ntag424_setup.py program --base URL --action END
  python ntag424_setup.py read                         # 태그를 읽어 URL 검증
  python ntag424_setup.py reset                        # 공장 초기 상태로 되돌리기

태그에 설정되는 것:
  - NDEF URL:  <base>?p=<암호화된 UID+카운터>&a=START&c=<CMAC>
    (p, c 는 태그가 읽힐 때마다 새로 생성됨 = SUN / Secure Dynamic Messaging)
  - Key 0 (마스터): 태그 설정 변경 보호
  - Key 1 (SDM Meta Read): p 값 암호화
  - Key 2 (SDM File Read): c 값(CMAC) 서명. a=START/END 문자열도 서명 범위에 포함
  - NDEF 파일 쓰기 권한: Key 0 (아무나 URL 을 덮어쓸 수 없음)

keys.json 은 절대 GitHub 에 올리지 말 것. (worktime/.gitignore 에 등록되어 있음)
"""
import argparse
import json
import os
import sys
import zlib

from Crypto.Cipher import AES
from Crypto.Hash import CMAC

KEYS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "keys.json")
ZERO_KEY = bytes(16)
NDEF_AID = bytes.fromhex("D2760000850101")
NDEF_FILE_NO = 0x02
KEY_VERSION = 0x01


# ---------------------------------------------------------------- crypto

def aes_cbc_enc(key, data, iv=ZERO_KEY):
    return AES.new(key, AES.MODE_CBC, iv=iv).encrypt(data)


def aes_cbc_dec(key, data, iv=ZERO_KEY):
    return AES.new(key, AES.MODE_CBC, iv=iv).decrypt(data)


def aes_ecb_enc(key, data):
    return AES.new(key, AES.MODE_ECB).encrypt(data)


def cmac(key, data):
    c = CMAC.new(key, ciphermod=AES)
    c.update(data)
    return c.digest()


def mac_t(key, data):
    """NXP 8바이트 truncated MAC (홀수 번째 바이트)."""
    return cmac(key, data)[1::2]


def pad80(data):
    data = data + b"\x80"
    return data + bytes((-len(data)) % 16)


def rotl(b):
    return b[1:] + b[:1]


def crc32nk(data):
    return ((zlib.crc32(data) ^ 0xFFFFFFFF) & 0xFFFFFFFF).to_bytes(4, "little")


def xor(a, b):
    return bytes(x ^ y for x, y in zip(a, b))


def sun_verify(meta_key, file_key, a, p, c):
    """서버(Code.gs)와 동일한 검증. 성공 시 (uid_hex, counter) 반환."""
    picc = aes_cbc_dec(meta_key, bytes.fromhex(p))
    if picc[0] != 0xC7:
        raise ValueError("PICC data tag mismatch (wrong SDM_META_KEY?)")
    uid, ctr = picc[1:8], picc[8:11]
    ses = cmac(file_key, bytes.fromhex("3CC300010080") + uid + ctr)
    expect = mac_t(ses, f"a={a}&c=".encode()).hex().upper()
    if expect != c.upper():
        raise ValueError("CMAC mismatch (wrong SDM_FILE_KEY or tampered URL)")
    return uid.hex().upper(), int.from_bytes(ctr, "little")


# ---------------------------------------------------------------- NDEF / SDM layout

def build_ndef(base, action):
    """NDEF 파일 내용과 SDM 오프셋을 계산."""
    if not base.startswith("https://"):
        raise ValueError("--base 는 https:// 로 시작해야 합니다")
    sep = "&" if "?" in base else "?"
    url = f"{base}{sep}p={'0' * 32}&a={action}&c={'0' * 16}"
    rest = url[len("https://"):].encode()
    payload = b"\x04" + rest                      # 0x04 = "https://"
    if len(payload) > 255:
        raise ValueError("URL 이 너무 깁니다")
    record = bytes([0xD1, 0x01, len(payload), 0x55]) + payload
    file_data = len(record).to_bytes(2, "big") + record
    url_start = 2 + 4 + 1                         # NLEN + record header + prefix
    off = lambda s: url_start + rest.index(s.encode()) + len(s)
    picc_off = off(sep + "p=")
    mac_off = off("&c=")
    mac_input_off = url_start + rest.index(f"&a={action}&c=".encode()) + 1
    return url, file_data, picc_off, mac_input_off, mac_off


def sdm_file_settings(picc_off, mac_input_off, mac_off):
    le3 = lambda n: n.to_bytes(3, "little")
    return (bytes([0x40])            # FileOption: SDM 사용, CommMode plain
            + bytes([0x00, 0xE0])    # RW=0 Change=0 | Read=E(누구나) Write=0
            + bytes([0xC1])          # SDMOptions: UID 미러 + 카운터 미러 + ASCII
            + bytes([0xFF, 0x12])    # RFU=F CtrRet=F | MetaRead=Key1 FileRead=Key2
            + le3(picc_off) + le3(mac_input_off) + le3(mac_off))


PLAIN_FILE_SETTINGS = bytes([0x00, 0xE0, 0xEE])   # 공장 기본값 (SDM 끔, 누구나 쓰기)


# ---------------------------------------------------------------- card I/O

class CardError(Exception):
    pass


class Tag:
    def __init__(self, transmit):
        self._tx = transmit  # (apdu: bytes) -> (data: bytes, sw: int)
        self.ti = None

    def apdu(self, apdu, ok=(0x9000, 0x9100)):
        data, sw = self._tx(bytes(apdu))
        if sw not in ok:
            raise CardError(f"APDU {bytes(apdu[:2]).hex()} failed: SW={sw:04X}")
        return data, sw

    def native(self, cmd, data=b"", ok=(0x9100,)):
        apdu = bytes([0x90, cmd, 0, 0]) + (bytes([len(data)]) + data if data else b"") + b"\x00"
        return self.apdu(apdu, ok)

    def select_app(self):
        self.ti = None
        self.apdu(bytes([0x00, 0xA4, 0x04, 0x0C, len(NDEF_AID)]) + NDEF_AID)

    def select_ndef_file(self):
        self.apdu(bytes.fromhex("00A4020C02E104"))

    def update_binary(self, data):
        for i in range(0, len(data), 48):
            chunk = data[i:i + 48]
            self.apdu(bytes([0x00, 0xD6, i >> 8, i & 0xFF, len(chunk)]) + chunk)

    def read_binary(self, length):
        data, _ = self.apdu(bytes([0x00, 0xB0, 0x00, 0x00, length]))
        return data

    def get_uid(self):
        try:
            data, _ = self.apdu(bytes.fromhex("FFCA000000"))
            return data.hex().upper()
        except CardError:
            return None

    def authenticate(self, key_no, key):
        """AuthenticateEV2First. 실패하면 False."""
        data, sw = self._tx(bytes([0x90, 0x71, 0, 0, 2, key_no, 0, 0]))
        if sw != 0x91AF:
            return False
        rnd_b = aes_cbc_dec(key, data)
        rnd_a = os.urandom(16)
        msg = aes_cbc_enc(key, rnd_a + rotl(rnd_b))
        data, sw = self._tx(bytes([0x90, 0xAF, 0, 0, 32]) + msg + b"\x00")
        if sw != 0x9100:
            return False
        dec = aes_cbc_dec(key, data)
        if dec[4:20] != rotl(rnd_a):
            raise CardError("RndA mismatch during authentication")
        self.ti = dec[0:4]
        sv = rnd_a[0:2] + xor(rnd_a[2:8], rnd_b[0:6]) + rnd_b[6:16] + rnd_a[8:16]
        self.k_enc = cmac(key, bytes.fromhex("A55A00010080") + sv)
        self.k_mac = cmac(key, bytes.fromhex("5AA500010080") + sv)
        self.cmd_ctr = 0
        return True

    def full_cmd(self, cmd, header, data, expect_mac=True):
        """CommMode.Full 명령 (암호화 + MAC)."""
        if self.ti is None:
            raise CardError("not authenticated")
        ctr = self.cmd_ctr.to_bytes(2, "little")
        iv = aes_ecb_enc(self.k_enc, bytes.fromhex("A55A") + self.ti + ctr + bytes(8))
        enc = aes_cbc_enc(self.k_enc, pad80(data), iv)
        mac = mac_t(self.k_mac, bytes([cmd]) + ctr + self.ti + header + enc)
        resp, _ = self.native(cmd, header + enc + mac)
        self.cmd_ctr += 1
        if expect_mac:
            ctr = self.cmd_ctr.to_bytes(2, "little")
            if len(resp) < 8 or resp[-8:] != mac_t(self.k_mac, b"\x00" + ctr + self.ti + resp[:-8]):
                raise CardError("response MAC mismatch")
        return resp

    def change_file_settings(self, settings):
        self.full_cmd(0x5F, bytes([NDEF_FILE_NO]), settings)

    def change_key(self, key_no, new_key, old_key):
        if key_no == 0:
            # 인증에 사용한 키 자신을 바꾸면 세션이 종료되므로 응답 MAC 없음
            self.full_cmd(0xC4, b"\x00", new_key + bytes([KEY_VERSION]), expect_mac=False)
            self.ti = None
        else:
            data = xor(new_key, old_key) + bytes([KEY_VERSION]) + crc32nk(new_key)
            self.full_cmd(0xC4, bytes([key_no]), data)


# ---------------------------------------------------------------- operations

def load_keys():
    if not os.path.exists(KEYS_FILE):
        sys.exit(f"{KEYS_FILE} 가 없습니다. 먼저 `genkeys` 를 실행하세요.")
    with open(KEYS_FILE) as f:
        k = json.load(f)
    return {n: bytes.fromhex(k[n]) for n in ("K0_MASTER", "K1_SDM_META", "K2_SDM_FILE")}


KEY_NAMES = {0: "K0_MASTER", 1: "K1_SDM_META", 2: "K2_SDM_FILE"}


def probe_keys(tag, keys):
    """Key 0/1/2 가 각각 지금 공장 키(0x00..)인지 keys.json 의 키인지 인증해서 확인.
    중간에 끊겨 일부 키만 바뀐 태그도 이어서 설정할 수 있게 함."""
    current = {}
    for n, name in KEY_NAMES.items():
        for candidate in (ZERO_KEY, keys[name]):
            tag.select_app()
            if tag.authenticate(n, candidate):
                current[n] = candidate
                break
        else:
            raise CardError(f"Key {n} 인증 실패: 공장 키도 keys.json 의 키도 아닙니다. "
                            "다른 keys.json 으로 설정된 태그일 수 있습니다.")
    return current


def auth_master(tag, key):
    tag.select_app()
    if not tag.authenticate(0, key):
        raise CardError("Key 0 재인증 실패")


def program(tag, keys, base, action):
    url, file_data, picc_off, mac_in_off, mac_off = build_ndef(base, action)
    current = probe_keys(tag, keys)

    # 1) 파일을 잠시 '누구나 쓰기' 로 열고 URL 을 기록
    auth_master(tag, current[0])
    tag.change_file_settings(PLAIN_FILE_SETTINGS)
    tag.select_app()
    tag.select_ndef_file()
    tag.update_binary(file_data)

    # 2) SDM 켜고 쓰기 잠금, 아직 안 바뀐 키만 교체 (Key 0 은 맨 마지막)
    auth_master(tag, current[0])
    tag.change_file_settings(sdm_file_settings(picc_off, mac_in_off, mac_off))
    for n in (1, 2, 0):
        target = keys[KEY_NAMES[n]]
        if current[n] != target:
            tag.change_key(n, target, current[n])
    return url, len(file_data)


def read_and_verify(tag, keys, length=None):
    tag.select_app()
    tag.select_ndef_file()
    if length is None:
        length = int.from_bytes(tag.read_binary(2), "big") + 2
    data = tag.read_binary(length)
    rec = data[2:]
    url = "https://" + rec[5:4 + rec[2]].decode()
    from urllib.parse import urlparse, parse_qs
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    uid, ctr = sun_verify(keys["K1_SDM_META"], keys["K2_SDM_FILE"], q["a"], q["p"], q["c"])
    return url, q["a"], uid, ctr


def reset(tag, keys):
    current = probe_keys(tag, keys)
    auth_master(tag, current[0])
    tag.change_file_settings(PLAIN_FILE_SETTINGS)
    for n in (1, 2, 0):
        if current[n] != ZERO_KEY:
            tag.change_key(n, ZERO_KEY, current[n])


# ---------------------------------------------------------------- CLI

def connect_reader():
    try:
        from smartcard.System import readers
    except ImportError:
        sys.exit("pyscard 가 없습니다:  pip install pyscard pycryptodome")
    rs = readers()
    if not rs:
        sys.exit("NFC 리더기를 찾지 못했습니다. USB 연결과 드라이버를 확인하세요.")
    print(f"리더기: {rs[0]}")
    conn = rs[0].createConnection()
    try:
        conn.connect()
    except Exception:
        sys.exit("태그가 감지되지 않습니다. 태그를 리더기 위에 올려두고 다시 실행하세요.")

    def transmit(apdu):
        try:
            data, sw1, sw2 = conn.transmit(list(apdu))
        except Exception as e:
            raise CardError("태그와 통신이 끊겼습니다. 태그를 리더기 정중앙에 평평하게 올려두고 "
                            "같은 명령을 다시 실행하세요. (중간에 끊겨도 다시 실행하면 이어서 설정됩니다)"
                            f"\n  상세: {e}")
        return bytes(data), (sw1 << 8) | sw2

    return Tag(transmit)


def cmd_genkeys(_):
    if os.path.exists(KEYS_FILE):
        sys.exit(f"{KEYS_FILE} 가 이미 있습니다. 덮어쓰면 기존 태그를 쓸 수 없게 되니 삭제하지 마세요.")
    keys = {n: os.urandom(16).hex().upper() for n in ("K0_MASTER", "K1_SDM_META", "K2_SDM_FILE")}
    with open(KEYS_FILE, "w") as f:
        json.dump(keys, f, indent=2)
    print(f"생성 완료: {KEYS_FILE}  (백업해 두고, 절대 GitHub 에 올리지 마세요)\n")
    print("Apps Script > 프로젝트 설정 > 스크립트 속성에 아래 두 개를 추가하세요:")
    print(f"  SDM_META_KEY = {keys['K1_SDM_META']}")
    print(f"  SDM_FILE_KEY = {keys['K2_SDM_FILE']}")
    print("(K0_MASTER 는 서버에 넣지 않습니다)")


def cmd_program(args):
    keys = load_keys()
    tag = connect_reader()
    uid = tag.get_uid()
    print(f"태그 UID: {uid or '(리더기가 UID 조회를 지원하지 않음)'}")
    url, length = program(tag, keys, args.base, args.action)
    print(f"기록한 URL 템플릿: {url}")
    url, a, uid, ctr = read_and_verify(tag, keys, length)
    print(f"검증 성공 ✅  action={a} uid={uid} counter={ctr}")
    print(f"예시 URL: {url}")


def cmd_read(_):
    keys = load_keys()
    url, a, uid, ctr = read_and_verify(connect_reader(), keys)
    print(f"URL: {url}\n검증 성공 ✅  action={a} uid={uid} counter={ctr}")


def cmd_reset(_):
    reset(connect_reader(), load_keys())
    print("공장 초기 상태(모든 키 0x00, SDM 꺼짐)로 되돌렸습니다.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("genkeys").set_defaults(fn=cmd_genkeys)
    p = sub.add_parser("program")
    p.add_argument("--base", required=True, help="PWA 주소, 예: https://xxx.github.io/Commande-Tapfruit/worktime/")
    p.add_argument("--action", required=True, choices=["START", "END"])
    p.set_defaults(fn=cmd_program)
    sub.add_parser("read").set_defaults(fn=cmd_read)
    sub.add_parser("reset").set_defaults(fn=cmd_reset)
    args = ap.parse_args()
    try:
        args.fn(args)
    except CardError as e:
        sys.exit(f"오류: {e}")


if __name__ == "__main__":
    main()
