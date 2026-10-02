"""
리더기/태그 없이 ntag424_setup.py 를 검증하는 테스트.
  1) NXP AN12196 공식 테스트 벡터
  2) 소프트웨어로 흉내 낸 NTAG 424 DNA 에 program / read / reset 전체 흐름 실행
실행:  python test_ntag424.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ntag424_setup as nt  # noqa: E402

H = bytes.fromhex
BASE = "https://contactmonsieurkim-pixel.github.io/Commande-Tapfruit/worktime/"


class FakeNtag424:
    """테스트용 NTAG 424 DNA (필요한 명령만 구현)."""

    def __init__(self, uid=H("04112233445566")):
        self.uid = uid
        self.keys = [bytes(16)] * 5
        self.file = bytearray(256)
        self.settings = bytes(nt.PLAIN_FILE_SETTINGS)
        self.sdm_ctr = 0
        self.ef = None
        self.session = None
        self.pending = None

    # -- helpers
    def _ar(self):
        ar = self.settings[1:3]
        return {"rw": ar[0] >> 4, "change": ar[0] & 0xF, "read": ar[1] >> 4, "write": ar[1] & 0xF}

    def _mirrored(self):
        data = bytearray(self.file)
        s = self.settings
        if not s[0] & 0x40:
            return bytes(data)
        self.sdm_ctr += 1
        le = lambda b: int.from_bytes(b, "little")
        picc_off, mac_in_off, mac_off = le(s[6:9]), le(s[9:12]), le(s[12:15])
        ctr = self.sdm_ctr.to_bytes(3, "little")
        picc = nt.aes_cbc_enc(self.keys[1], bytes([0xC7]) + self.uid + ctr + os.urandom(5))
        data[picc_off:picc_off + 32] = picc.hex().upper().encode()
        ses = nt.cmac(self.keys[2], H("3CC300010080") + self.uid + ctr)
        mac = nt.mac_t(ses, bytes(data[mac_in_off:mac_off]))
        data[mac_off:mac_off + 16] = mac.hex().upper().encode()
        return bytes(data)

    def transmit(self, apdu):
        cla, ins = apdu[0], apdu[1]
        if apdu == H("00A4040C07D2760000850101"):
            self.ef, self.session = None, None
            return b"", 0x9000
        if apdu == H("00A4020C02E104"):
            self.ef = 2
            return b"", 0x9000
        if apdu == H("FFCA000000"):
            return self.uid, 0x9000
        if cla == 0x00 and ins == 0xD6:
            if self.ef != 2 or self._ar()["write"] != 0xE:
                return b"", 0x6982
            off, n = (apdu[2] << 8) | apdu[3], apdu[4]
            self.file[off:off + n] = apdu[5:5 + n]
            return b"", 0x9000
        if cla == 0x00 and ins == 0xB0:
            if self.ef != 2 or self._ar()["read"] != 0xE:
                return b"", 0x6982
            off, n = (apdu[2] << 8) | apdu[3], apdu[4]
            return self._mirrored()[off:off + n], 0x9000
        if cla == 0x90 and ins == 0x71:
            key_no = apdu[5]
            self.rnd_b = os.urandom(16)
            self.pending = key_no
            return nt.aes_cbc_enc(self.keys[key_no], self.rnd_b), 0x91AF
        if cla == 0x90 and ins == 0xAF:
            k = self.keys[self.pending]
            dec = nt.aes_cbc_dec(k, apdu[5:37])
            rnd_a, rnd_b_rot = dec[:16], dec[16:]
            if rnd_b_rot != nt.rotl(self.rnd_b):
                self.session = None
                return b"", 0x91AE
            ti = os.urandom(4)
            sv = rnd_a[0:2] + nt.xor(rnd_a[2:8], self.rnd_b[0:6]) + self.rnd_b[6:16] + rnd_a[8:16]
            self.session = dict(key_no=self.pending, ti=ti, ctr=0,
                                enc=nt.cmac(k, H("A55A00010080") + sv),
                                mac=nt.cmac(k, H("5AA500010080") + sv))
            return nt.aes_cbc_enc(k, ti + nt.rotl(rnd_a) + bytes(12)), 0x9100
        if cla == 0x90 and ins in (0x5F, 0xC4):
            return self._full(ins, apdu[5:5 + apdu[4]])
        return b"", 0x6D00

    def _full(self, cmd, body):
        s = self.session
        if s is None:
            return b"", 0x91AE
        header, enc, mac = body[:1], body[1:-8], body[-8:]
        ctr = s["ctr"].to_bytes(2, "little")
        if mac != nt.mac_t(s["mac"], bytes([cmd]) + ctr + s["ti"] + header + enc):
            return b"", 0x911E
        iv = nt.aes_ecb_enc(s["enc"], H("A55A") + s["ti"] + ctr + bytes(8))
        data = nt.aes_cbc_dec(s["enc"], enc, iv)
        data = data[:data.rindex(b"\x80")]
        s["ctr"] += 1
        if cmd == 0x5F:
            if s["key_no"] != self._ar()["change"]:
                return b"", 0x919D
            self.settings = data
        else:
            key_no = header[0]
            if key_no == s["key_no"]:
                self.keys[key_no] = data[:16]
                self.session = None
                return b"", 0x9100
            new = nt.xor(data[:16], self.keys[key_no])
            if data[17:21] != nt.crc32nk(new):
                return b"", 0x911E
            self.keys[key_no] = new
        rctr = s["ctr"].to_bytes(2, "little")
        return nt.mac_t(s["mac"], b"\x00" + rctr + s["ti"]), 0x9100


class Vectors(unittest.TestCase):
    """NXP AN12196 의 공식 예제 값."""

    def test_sun_plain(self):
        picc = nt.aes_cbc_dec(bytes(16), H("EF963FF7828658A599F3041510671E88"))
        self.assertEqual(picc[1:8].hex().upper(), "04DE5F1EACC040")
        self.assertEqual(int.from_bytes(picc[8:11], "little"), 61)

    def test_sun_mac(self):
        picc = nt.aes_cbc_dec(bytes(16), H("EF963FF7828658A599F3041510671E88"))
        ses = nt.cmac(bytes(16), H("3CC300010080") + picc[1:11])
        self.assertEqual(nt.mac_t(ses, b"").hex().upper(), "94EED9EE65337086")

    def test_sun_mac_with_input(self):
        picc = nt.aes_cbc_dec(bytes(16), H("FD91EC264309878BE6345CBE53BADF40"))
        ses = nt.cmac(bytes(16), H("3CC300010080") + picc[1:11])
        mac = nt.mac_t(ses, b"CEE9A53E3E463EF1F459635736738962&cmac=")
        self.assertEqual(mac.hex().upper(), "ECC1E7F6C6C73BF6")


class Flow(unittest.TestCase):
    def setUp(self):
        self.keys = {n: os.urandom(16) for n in ("K0_MASTER", "K1_SDM_META", "K2_SDM_FILE")}
        self.card = FakeNtag424()
        self.tag = nt.Tag(self.card.transmit)

    def test_program_and_read(self):
        url, length = nt.program(self.tag, self.keys, BASE, "START")
        self.assertTrue(url.startswith(BASE + "?p="))
        self.assertIn("&a=START&c=", url)
        self.assertEqual(self.card.keys[0], self.keys["K0_MASTER"])
        _, a, uid, c1 = nt.read_and_verify(self.tag, self.keys, length)
        _, _, _, c2 = nt.read_and_verify(self.tag, self.keys)
        self.assertEqual((a, uid), ("START", "04112233445566"))
        self.assertGreater(c2, c1)

    def test_write_locked_after_program(self):
        nt.program(self.tag, self.keys, BASE, "END")
        self.tag.select_app()
        self.tag.select_ndef_file()
        with self.assertRaises(nt.CardError):
            self.tag.update_binary(b"hack")

    def test_reprogram_with_same_keys(self):
        nt.program(self.tag, self.keys, BASE, "START")
        nt.program(self.tag, self.keys, BASE, "END")
        _, a, _, _ = nt.read_and_verify(self.tag, self.keys)
        self.assertEqual(a, "END")

    def test_tampered_action_rejected(self):
        nt.program(self.tag, self.keys, BASE, "START")
        url, _, _, _ = nt.read_and_verify(self.tag, self.keys)
        q = dict(kv.split("=") for kv in url.split("?")[1].split("&"))
        with self.assertRaises(ValueError):
            nt.sun_verify(self.keys["K1_SDM_META"], self.keys["K2_SDM_FILE"], "END", q["p"], q["c"])

    def test_reset(self):
        nt.program(self.tag, self.keys, BASE, "START")
        nt.reset(self.tag, self.keys)
        self.assertEqual(self.card.keys[:3], [bytes(16)] * 3)
        self.assertEqual(self.card.settings, nt.PLAIN_FILE_SETTINGS)

    def _drop_once(self, key_no, applied):
        """Key n 의 ChangeKey 도중 통신 끊김을 한 번 흉내 (applied=태그는 적용했는데 응답만 유실)."""
        real = self.card.transmit
        state = {"done": False}

        def transmit(apdu):
            if not state["done"] and apdu[:2] == b"\x90\xC4" and apdu[5] == key_no:
                state["done"] = True
                if applied:
                    real(apdu)
                self.card.session = None
                raise nt.CardError("Transaction failed (simulated)")
            return real(apdu)
        return nt.Tag(transmit)

    def test_resume_after_drop(self):
        for key_no in (1, 2, 0):
            for applied in (False, True):
                with self.subTest(key_no=key_no, applied=applied):
                    self.setUp()
                    with self.assertRaises(nt.CardError):
                        nt.program(self._drop_once(key_no, applied), self.keys, BASE, "END")
                    nt.program(self.tag, self.keys, BASE, "END")
                    _, a, _, _ = nt.read_and_verify(self.tag, self.keys)
                    self.assertEqual(a, "END")
                    self.assertEqual(self.card.keys[:3], [self.keys[n] for n in ("K0_MASTER","K1_SDM_META","K2_SDM_FILE")])

    def test_reset_after_partial(self):
        with self.assertRaises(nt.CardError):
            nt.program(self._drop_once(2, False), self.keys, BASE, "START")
        nt.reset(self.tag, self.keys)
        self.assertEqual(self.card.keys[:3], [bytes(16)] * 3)

    def test_unknown_key_rejected(self):
        self.card.keys[0] = os.urandom(16)
        with self.assertRaises(nt.CardError):
            nt.program(self.tag, self.keys, BASE, "START")


if __name__ == "__main__":
    unittest.main(verbosity=2)
