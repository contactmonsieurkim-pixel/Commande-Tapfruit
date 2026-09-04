// Rebuild the recipe BOM against the REAL current Item Master.
// Input : the uploaded recipe CSV (clean source, empty ingredientId).
// Output: data/bom-corrected.tsv  (paste into BOM tab)
//         data/bom-new-items.tsv  (Item rows to add first, so ids resolve)
// Also prints a decision report (matched / flagged / new).
const fs = require('fs');
const REPO = '/home/user/Commande-Tapfruit';
const CSV  = '/root/.claude/uploads/4197afa1-7307-5317-8fa8-b4ffd8b9ec26/90455f22-geminicode1788545302801.csv';
const DATE = '2026-09-04T00:00:00.000Z';

// ---- Authoritative ids from the live Item Master (read 2026-09-04) ----
// key = lowercased CSV ingredientName ; val = [id, canonicalMasterName, confidence, note]
// confidence: H high, M medium(flag for review)
const MAP = {
  'apple juice'              : ['mtmvkvcq7ydlp','Jus de Pomme','H'],
  'apple juice ' /*black*/   : ['mtmvkvcq7ydlp','Jus de Pomme','H'],
  'honey'                    : ['mtmvc9i99du0f','Miel Fleur','H'],
  'soy sauce'                : ['cfg-099','Sauce soja coréen','H'],
  'sesame oil'               : ['cfg-106','Huile de sésame (jia)','H'],
  'white pepper'             : ['mtmwbiw3iziox','Poivre Blanc moulu','H'],
  'garlic puree'             : ['mtmu3svqpy1qm',"Pulpe d'Ail",'H'],
  'garlic pulpe'             : ['mtmu3svqpy1qm',"Pulpe d'Ail",'H'],
  'ginger puree'             : ['mtmtyr7nwq1rc','Purée Gingembre','H'],
  'ginger pulpe'             : ['mtmtyr7nwq1rc','Purée Gingembre','H'],
  'mirin'                    : ['cfg-107','Mirin (WADAKAN) 9%','H'],
  'salt'                     : ['mtmzf60vx0jf0','Sel Fin','H'],
  'sugar'                    : ['mtmvvkh1sq24d','Sucre Blanc poudre','H'],
  'sugar (meringue + cream)' : ['mtmvvkh1sq24d','Sucre Blanc poudre','H'],
  'fish sauce'               : ['cfg-105','Sauce Poisson','H'],
  'lemon juice'              : ['mtmvdlovu4zpb','Pulco Jus Citron','H'],
  'gochujang'                : ['cfg-096','Gochujang','H'],
  'poivron padron'           : ['mtmujkfwxwy40','Poivron Padron','H'],
  'concentrated milk'        : ['mtmv7eu5xmhub','Lait Concentré','H'],
  'milk'                     : ['mtmzh02wg5ixz','Lait entier','H'],
  'matcha powder'            : ['mtmvf1nqksjee','Matcha','H'],
  'pat (grain)'              : ['cfg-104','Grain de Azuki','H'],
  'chapsal flour'            : ['cfg-102','Poudre Riz Gluant','H'],
  'fécule pdt'               : ['mtmw5ml1m32w8','Fécule PDT','H'],
  'farine t45'               : ['mtmw4crz8njlr','Farine T45','H'],
  'glucose powder'           : ['mtmvb2ynot3u4','Glucose Atomisé','H'],
  'kombu'                    : ['cfg-109','Kombu sec','H'],
  'kombu (kombu broth)'      : ['cfg-109','Kombu sec','H'],
  'ketchup heinz'            : ['mtmw7vs68imzh','Ketchup Heinz','H'],
  'poudre piment fin'        : ['cfg-101','Poudre piment "Très Fin"','H'],
  'red pepper powder (fine)' : ['cfg-101','Poudre piment "Très Fin"','H'],
  'red pepper powder (coarse)':['cfg-100','Poudre piment Gros','H'],
  'poudre poivre blanc'      : ['mtmwbiw3iziox','Poivre Blanc moulu','H'],
  'garlic'                   : ['mtmu05i8e2uqm','Ail pelé','H'],
  'ginger'                   : ['mtmtqfo12eh4w','Gingembre frais','H'],
  'ginger slice'             : ['mtmtqfo12eh4w','Gingembre frais','H'],
  "blanc d'oeuf (egg white)" : ['mtmuwuejxelaj',"Blanc d'Oeuf Pasteurisé",'H'],
  "jaune d'oeuf (egg yolk)"  : ['mtmuvz5mauryx',"Jaune d'Oeuf Pasteurisé",'H'],
  'biscuit cuiller'          : ['mtmvn4lp7doh0','Biscuit Cuillers','H'],
  // ---- water: user already uses one "Eau" item for every water variant ----
  'water'                    : ['mtn5pngq4nxog','Eau','H'],
  'hot water'                : ['mtn5pngq4nxog','Eau','H'],
  'cold water'               : ['mtn5pngq4nxog','Eau','H'],
  'boiling water'            : ['mtn5pngq4nxog','Eau','H'],
  'very cold water'          : ['mtn5pngq4nxog','Eau','H'],
  'water (broth + chapsal)'  : ['mtn5pngq4nxog','Eau','H'],
  // ---- medium confidence (mapped but FLAG) ----
  'plum syrup'               : ['cfg-098','Thé Prune','M','plum tea/syrup 매실 — confirm this is your plum syrup'],
  'neutral oil'              : ['mtmwa9m1ynjkw','Huile Friture','M','using frying oil as the neutral oil'],
  'fresh chili pepper slice' : ['mtmuhb8bu61t0','Piment vert','M','green chili used for fresh chili — confirm colour'],
};

// mascarpone is split across two master items
const MASCARPONE = [['mtmrcnkljdu86','Mascarpone Galbani'],['mtmrdlenxwaay','Mascarapone Bianco']];

// ---- ingredients NOT in the master -> propose new Item rows ----
// key -> [newId, name, category, subCategory, note]
const NEW = {
  'ma-seng-mi'        : ['ing-maseng',  'Ma-seng-mi (매생이)',        'Supplier Goods','Staple Stock','green seaweed'],
  'xanthan gum'       : ['ing-xanthan', 'Xanthan Gum',                'Supplier Goods','Staple Stock',''],
  'scallion'          : ['ing-scallion','Scallion (Ciboule)',         'Supplier Goods','Fresh Raw Goods','green onion — not the leek/Poireau'],
  'pear'              : ['ing-pear',    'Pear (Poire Coréenne)',      'Supplier Goods','Fresh Raw Goods','fresh Korean pear'],
  'espresso'          : ['ing-espresso','Espresso',                   'Production','Inter-Prod.','shot pulled in-house'],
  'nectar pear'       : ['ing-nectpear','Nectar Poire Coréen',        'Supplier Goods','Staple Stock','Korean pear nectar/juice'],
  'shiitake powder'   : ['ing-shiitakep','Shiitake Powder',           'Supplier Goods','Staple Stock','ground shiitake (distinct from dried whole)'],
  // ---- chicken-powder spice line: only white pepper exists as a powder ----
  'poudre muscade'    : ['ing-muscade', 'Poudre Muscade (Nutmeg)',    'Supplier Goods','Staple Stock',''],
  'poudre cannelle'   : ['ing-cannellep','Poudre Cannelle (Cinnamon)','Supplier Goods','Staple Stock','GROUND — master only has Cannelle ENTIERE (whole)'],
  'poudre ail'        : ['ing-ailp',    'Poudre Ail (Garlic pwd)',    'Supplier Goods','Staple Stock','powder — not fresh Ail pelé'],
  'poudre gingembre'  : ['ing-gingembrp','Poudre Gingembre (Ginger pwd)','Supplier Goods','Staple Stock','powder — not fresh ginger'],
  'poudre coriandre'  : ['ing-coriandr','Poudre Coriandre',           'Supplier Goods','Staple Stock',''],
  'poudre curcuma'    : ['ing-curcuma', 'Poudre Curcuma (Turmeric)',  'Supplier Goods','Staple Stock',''],
  'poudre cardamome'  : ['ing-cardamom','Poudre Cardamome',           'Supplier Goods','Staple Stock',''],
  'poudre poivre noir': ['ing-poivrenoir','Poudre Poivre Noir (Black pepper pwd)','Supplier Goods','Staple Stock','master only has WHITE ground pepper'],
};

// ---- the 19 recipe parents -> propose Production Item rows ----
// id -> [name, subCategory]  (subCategory: sauces served ready = RTU-Prod.; sub-preps = Inter-Prod.)
const PARENTS = {
  'mtn5saucegalb1':['Sauce Galbi (Ma-seng-mi)','RTU-Prod.'],
  'mtn5saucegalb2':['Sauce Galbi (No Ma-seng-mi)','RTU-Prod.'],
  'mtn5tartarenat':['Sauce Tartare Nature','RTU-Prod.'],
  'mtn5tartarepiq':['Sauce Tartare Piquant','RTU-Prod.'],
  'mtn5sauctemple':['Sauce Temple','RTU-Prod.'],
  'mtn5bingsubase':['Bingsu Base','Inter-Prod.'],
  'mtn5matchasauc':['Matcha Sauce','RTU-Prod.'],
  'mtn5patbingsu0':['Pat for Bingsu','Inter-Prod.'],
  'mtn5bingsuttok':['Bingsu Ttok','Inter-Prod.'],
  'mtn5chickpowd1':['Chicken Powder','Inter-Prod.'],
  'mtn5chickmari1':['Chicken Marinade (2.5kg)','Inter-Prod.'],
  'mtn5chickfry5k':['Frying Chicken (5kg Base)','Inter-Prod.'],
  'mtn5chickfry7k':['Frying Chicken (7.5kg Base)','Inter-Prod.'],
  'mtn5chickfry10':['Frying Chicken (10kg Base)','Inter-Prod.'],
  'mtn5sauceblack':['Sauce BLACK','RTU-Prod.'],
  'mtn5saucered00':['Sauce RED','RTU-Prod.'],
  'mtn5dakgalbiso':['Sauce Dak-Galbi','RTU-Prod.'],
  'mtn5kimchisauc':['Kimchi Sauce Base (40kg Cabbage)','Inter-Prod.'],
  'mtn5tiramisu00':['Basic Tiramisu','RTU-Prod.'],
};

// Chicken Powder is used as an ingredient inside Chicken Marinade -> self-referential prod id
const INTERMEDIATE = { 'chicken powder': ['mtn5chickpowd1','Chicken Powder','H'] };

// -------------------------------------------------------------------
const rows = fs.readFileSync(CSV,'utf8').split('\n').map(l=>l.replace(/\r$/,'')).filter(l=>l.trim());
rows.shift(); // header

const out = [];            // corrected BOM rows
const report = { H:0, flag:[], newUsed:{}, unresolved:[] };
const parentsSeen = new Set();

for (const line of rows) {
  const c = line.split(',');
  const parentId = c[0].trim(), parentName = c[1].trim();
  const ingName = c[3].trim(), qty = c[4].trim(), unit = c[5] ? c[5].trim() : '';
  parentsSeen.add(parentId);
  const key = ingName.toLowerCase();

  // special: Mascarpone split
  if (key.startsWith('mascarpone')) {
    const half = (Number(qty)/2);
    MASCARPONE.forEach(([id,nm])=>out.push([parentId,parentName,id,nm,half,unit]));
    report.flag.push(`${parentName}: Mascarpone ${qty}g split 50/50 -> Galbani ${half} + Bianco ${half} (adjust ratio if needed)`);
    report.H++; continue;
  }
  let m = INTERMEDIATE[key] || MAP[key];
  if (m) {
    out.push([parentId,parentName,m[0],m[1],qty,unit]);
    if (m[2]==='M') report.flag.push(`${parentName}: "${ingName}" -> ${m[1]} (${m[0]}) — ${m[3]}`);
    report.H++;
    continue;
  }
  let n = NEW[key];
  if (n) {
    out.push([parentId,parentName,n[0],n[1],qty,unit]);
    report.newUsed[n[0]] = n;
    continue;
  }
  // unresolved
  out.push([parentId,parentName,'',ingName,qty,unit]);
  report.unresolved.push(`${parentName}: ${ingName}`);
}

// French-locale qty: 2.5 -> 2,5  (sheet uses comma decimals)
const fr = v => String(v).replace('.', ',');
out.forEach(r => { r[4] = fr(r[4]); });

// write corrected BOM (TSV)
const HDR = ['parentId','parentName','ingredientId','ingredientName','qty','unit'];
fs.writeFileSync(REPO+'/data/bom-corrected.tsv', [HDR, ...out].map(r=>r.join('\t')).join('\n')+'\n');

// ---- full-replacement BOM = user's own good recipes (verbatim from live sheet) + corrected block ----
const KEEP = [
  ['mtlyjvzgm9ye5','Haricot vert Cut','mtlyhsaviof8p','Haricot vert','5','box'],
  ['mtlywr2hv0qo4','Shiitake in water','mtlyt7jvnbdg8','Shiitake Sec','2','box'],
  ['mtlyxzalr723g','Shiitake Cut','mtlywr2hv0qo4','Shiitake in water','1','box'],
  ['mtlz0orbntwml','Shiitake Finish','mtlyxzalr723g','Shiitake Cut','0,34','box'],
  ['mtlyqhe2mb0ya','Radish Finish','mtlyo3vg8hr4h','Radis Rouge','1','box'],
  ['mtlykyhgwi651','Haricot vert Finish','mtlyjvzgm9ye5','Haricot vert Cut','0,5','box'],
  ['mtlz7ob40hp31','Carotte Finish','mtlz3ahboz0dc','Carotte Rapée','1,5','box'],
  ['mtn5nzogyjduy','Ssamjang','cfg-097','Doenjang','2500','g'],
  ['mtn5nzogyjduy','Ssamjang','cfg-096','Gochujang','500','g'],
  ['mtn5nzogyjduy','Ssamjang','mtmvkvcq7ydlp','Jus de Pomme','1500','g'],
  ['mtn5nzogyjduy','Ssamjang','mtmvvkh1sq24d','Sucre blanc poudre','150','g'],
  ['mtn5nzogyjduy','Ssamjang','cfg-106','Huile de sésame (jia) (Bte 2.5L)','40','g'],
  ['mtn5sa2rwe25u','Soupe Cannelle','mtn5pngq4nxog','Eau','2000','g'],
  ['mtn5sa2rwe25u','Soupe Cannelle','mtmw0clasmbru','Cannelle ENTIERE','100','g'],
  ['mtn5sa2rwe25u','Soupe Cannelle','mtmtqfo12eh4w','Gingembre frais','80','g'],
  ['mtn5sa2rwe25u','Soupe Cannelle','mtmw2b96tvkzc','Jujube Sec','100','g'],
  ['mtn5sa2rwe25u','Soupe Cannelle','mtmvz62q559ue','SUCRE DE CANNE EN POUDRE BRUN SWB','400','g'],
  ['mtn5ww95da7q6','Poudre Sésame (Cuit)','cfg-103','Sésame blanc','4','box'],
  ['mtn5zx8su1jis','Sésame Juice','mtn5pngq4nxog','eau','850','g'],
  ['mtn5zx8su1jis','Sésame Juice','cfg-109','Kombu sec','20','g'],
  ['mtn5zx8su1jis','Sésame Juice','mtmunvh95945u','Tofu ferme','450','g'],
  ['mtn5zx8su1jis','Sésame Juice','mtmw6soto6cjn','Pignon PIN','200','g'],
  ['mtn5zx8su1jis','Sésame Juice','mtn5ww95da7q6','Poudre Sésame (Cuit)','35','g'],
  ['mtn5zx8su1jis','Sésame Juice','mtmzf60vx0jf0','Sel Fin','15','g'],
  ['mtn5zx8su1jis','Sésame Juice','mtmvdlovu4zpb','Pulco Jus Citron','3','g'],
  ['mtn5zx8su1jis','Sésame Juice','mtmvvkh1sq24d','Sucre blanc poudre','15','g'],
  ['mtn5zx8su1jis','Sésame Juice','mtn61ij89drpj','Balsamic Blanc','20','g'],
  ['mtn67k80kq8k8','Radish for Chicken','mtlyo3vg8hr4h','Radis Rouge','24000','g'],
  ['mtn67k80kq8k8','Radish for Chicken','mtmvvkh1sq24d','Sucre blanc poudre','6000','g'],
  ['mtn67k80kq8k8','Radish for Chicken','mtn5pngq4nxog','Eau','6000','g'],
  ['mtn67k80kq8k8','Radish for Chicken','mtmw96khte5q9','aro Vinaigre blanc 8°','6000','g'],
  ['mtn6cx7nbtz7g','Jang-A-Chi (Celeri)','mtmtnwbi1y5ip','Celeri Botte','9600','g'],
  ['mtn6cx7nbtz7g','Jang-A-Chi (Celeri)','mtmuhb8bu61t0','Piment vert','3000','g'],
  ['mtn6cx7nbtz7g','Jang-A-Chi (Celeri)','mtn5pngq4nxog','Eau','6000','g'],
  ['mtn6cx7nbtz7g','Jang-A-Chi (Celeri)','mtmvvkh1sq24d','Sucre blanc poudre','6000','g'],
  ['mtn6cx7nbtz7g','Jang-A-Chi (Celeri)','mtmw96khte5q9','aro Vinaigre blanc 8°','6000','g'],
  ['mtn6cx7nbtz7g','Jang-A-Chi (Celeri)','cfg-099','Sauce soja corén','3000','g'],
];
fs.writeFileSync(REPO+'/data/bom-full.tsv', [HDR, ...KEEP, ...out].map(r=>r.join('\t')).join('\n')+'\n');

// write new-items TSV (Items-tab layout, 20 cols) for ingredients to add
const ICOLS = ['id','name','category','subCategory','menus','avgShelfLifeDays','suppliers','orderUnit','gramsPerOrderUnit','piecesPerOrderUnit','unitPrice','parLevel','boxSize','gramsPerBox','createdBy','createdAt','updatedBy','updatedAt','batchYield','supplierRef'];
const irows = [];
Object.values(NEW).forEach(([id,name,cat,sub])=>{
  irows.push([id,name,cat,sub,'','','','','','','','','','','import',DATE,'import',DATE,'','']);
});
fs.writeFileSync(REPO+'/data/bom-new-items.tsv', [ICOLS, ...irows].map(r=>r.join('\t')).join('\n')+'\n');

// write parents TSV (Production Item rows)
const prows = [];
Object.entries(PARENTS).forEach(([id,[name,sub]])=>{
  prows.push([id,name,'Production',sub,'','','','','','','','','','','import',DATE,'import',DATE,'','']);
});
fs.writeFileSync(REPO+'/data/bom-parents.tsv', [ICOLS, ...prows].map(r=>r.join('\t')).join('\n')+'\n');

// ---- report ----
console.log('CORRECTED BOM ROWS: '+out.length+' across '+parentsSeen.size+' parents');
console.log('MATCHED to existing master: '+report.H);
console.log('\n--- FLAGGED (mapped, please confirm) ---');
report.flag.forEach(f=>console.log('  ⚑ '+f));
console.log('\n--- NEW ITEMS TO ADD ('+Object.keys(report.newUsed).length+' used of '+Object.keys(NEW).length+' defined) ---');
Object.values(report.newUsed).forEach(n=>console.log(`  + ${n[0]}  ${n[1]}  [${n[2]} / ${n[3]}]  ${n[4]||''}`));
console.log('\n--- UNRESOLVED (blank id) ---');
console.log(report.unresolved.length? report.unresolved.map(u=>'  ? '+u).join('\n') : '  none');
console.log('\n--- NON-GRAM UNITS still in BOM ---');
out.filter(r=>r[5] && r[5]!=='g').forEach(r=>console.log(`  ${r[3]}  ${r[4]} ${r[5]}  (in ${r[1]})`));
