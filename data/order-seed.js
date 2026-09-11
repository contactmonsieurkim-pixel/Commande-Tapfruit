// Parse the live Item Master rows (pasted from the sheet) into an order seed.
// Keep ONLY items whose `suppliers` field is non-empty (= things we order).
const fs = require('fs');
const RAW = `
mtlyhsaviof8p | Haricot vert | Supplier Goods | Fresh Raw Goods | Bibimbap | 7 | Metro, Tapfruit | 1 Pack | 500 |  | 4,72 |  |  |  | | | | | |
mtlym8ue09ufm | Mâche | Supplier Goods | Direct Goods | Bibimbap | 7 | Metro, Tapfruit | 1 Bag | 300 |  | 3,25 |  |  |  | | | | | |
mtlyo3vg8hr4h | Radis Rouge | Supplier Goods | Fresh Raw Goods | Bibimbap | 7 | Metro, Tapfruit | 1 Bag | 1500 |  | 6,28 |  |  |  | | | | | |
mtlyt7jvnbdg8 | Shiitake Sec | Supplier Goods | Staple Stock | Bibimbap | 120 | Leaf Market | 1 Pack | 500 |  | 15,5 | 4 |  |  | | | | | |
mtlz3ahboz0dc | Carotte Rapée | Supplier Goods | Fresh Raw Goods | Bibimbap | 7 | Metro, Tapfruit | 1 Bag | 1000 |  | 3,51 |  |  |  | | | | | |
mtmqybib5vovw | Échine de Porc | Supplier Goods | Fresh Raw Goods | BBQ Porc | 9 | Beauvallet | 1 Pack | 2200 |  | 14,74 |  |  |  | | | | | |
mtmr1i7x7k8y7 | Faux-Fillet Boeuf Angus Argentin | Supplier Goods | Fresh Raw Goods | BBQ Beef | 14 | Beauvallet | 1 Pack | 4500 |  | 112,5 |  |  |  | | | | | |
mtmr3ku4xs41q | Viande Cuisse Poulet Halal | Supplier Goods | Fresh Raw Goods | BBQ DAK, Chicken | 7 | Metro | 1 Pack | 2500 |  | 21,6 |  |  |  | | | | | |
mtmr8xinz9egs | Tartare Boeuf Charolais Couteaux | Supplier Goods | Fresh Raw Goods | Bibimbap | 7 | Beauvallet | 32 portions | 2880 |  | 57 |  |  |  | | | | | |
mtmrcnkljdu86 | Mascarpone Galbani | Supplier Goods | Staple Stock | Tiramisu | 28 | Metro | 1 Box | 500 |  | 6,44 | 3 |  |  | | | | | |
mtmrdlenxwaay | Mascarapone Bianco | Supplier Goods | Staple Stock | Tiramisu | 28 | Metro | 1 Box | 500 |  | 5 | 3 |  |  | | | | | |
mtmt5f3gs1wgl | Salade Romaine | Supplier Goods | Staple Stock | BBQ Porc, BBQ DAK, BBQ Beef | 7 | Metro, Tapfruit | 1 Box | 500 |  | 3,07 | 16 |  |  | | | | | |
mtmt9k5lkd4tk | Chou Chinois | Supplier Goods | Fresh Raw Goods | Kimchi Rouge | 7 | Metro, Tapfruit | 2 Pieces | 700 |  | 2,74 |  |  |  | | | | | |
mtmtcpfd7ko9k | Poireau | Supplier Goods | Fresh Raw Goods | Bibimbap | 7 | Metro, Tapfruit | 1 bunch | 1000 |  | 3,07 |  |  |  | | | | | |
mtmtjvyrrrer3 | Pomme Golden | Supplier Goods | Fresh Raw Goods | Kimchi Rouge, Kimchi Blanc | 7 | Metro | 1 box | 3200 |  | 8,77 |  |  |  | | | | | |
mtmtljy1o48ul | Choudou | Supplier Goods | Fresh Raw Goods | BBQ Porc, BBQ DAK, BBQ Beef | 7 | Metro | 1 Piece | 1000 |  | 3,07 |  |  |  | | | | | |
mtmtnwbi1y5ip | Celeri Botte | Supplier Goods | Fresh Raw Goods | Jang-A-Chi | 7 | Metro, Tapfruit | 1 bunch | 800 |  | 2,08 |  |  |  | | | | | |
mtmtqfo12eh4w | Gingembre frais | Supplier Goods | Staple Stock | Kimchi Rouge, Kimchi Blanc | 21 | Metro, Tapfruit | 1 box | 500 |  | 3,84 | 1 |  |  | | | | | |
mtmtyr7nwq1rc | Purée Gingembre | Supplier Goods | Staple Stock | BBQ Porc, BBQ DAK, BBQ Beef | 28 | Metro | 1 box | 450 |  | 6,59 | 6 |  |  | | | | | |
mtmu05i8e2uqm | Ail pelé | Supplier Goods | Staple Stock | Kimchi Rouge, Kimchi Blanc | 14 | Metro | 1 box | 1000 |  | 6,37 | 1 |  |  | | | | | |
mtmu3svqpy1qm | Pulpe d'Ail | Supplier Goods | Staple Stock | Kimchi Rouge, Kimchi Blanc | 28 | Metro | 1 box | 1000 |  | 6,59 | 4 |  |  | | | | | |
mtmudlro1za5t | Concombre | Supplier Goods | Staple Stock | Courgette | 7 | Metro, Tapfruit | 1 Piece | 500 |  | 1,64 | 2 |  |  | | | | | |
mtmuhb8bu61t0 | Piment vert | Supplier Goods | Fresh Raw Goods | Jang-A-Chi, Chicken | 10 | Metro, Tapfruit | 1 box | 3000 |  | 11,51 |  |  |  | | | | | |
mtmujkfwxwy40 | Poivron Padron | Supplier Goods | Staple Stock | Bibimbap | 10 | Metro | bag | 500 |  | 3,84 | 2 |  |  | | | | | |
mtmumc7hkjlja | Germe Poireau | Supplier Goods | Staple Stock | Chicken, BBQ Porc | 10 | Metro, Tapfruit | pack | 50 |  | 2,1 | 12 |  |  | | | | | |
mtmunvh95945u | Tofu ferme | Supplier Goods | Staple Stock | Courgette | 14 | Leaf Market | pack | 450 |  | 2,33 | 3 |  |  | | | | | |
mtmupfrnkta7u | Mûre | Supplier Goods | Staple Stock | Courgette | 7 | Metro, Tapfruit | pack | 125 |  | 2,52 | 4 |  |  | | | | | |
mtmuqnuof8phh | Groseille | Supplier Goods | Staple Stock | Courgette | 14 | Metro, Tapfruit | pack | 125 |  | 2,52 | 4 |  |  | | | | | |
mtmurtumqylpz | Melon Jaune | Supplier Goods | Staple Stock | Courgette | 7 | Metro, Tapfruit | piece | 1000 |  | 4,17 | 1 |  |  | | | | | |
mtmutgtcqw6kq | Courgette | Supplier Goods | Staple Stock | Courgette | 14 | Metro, Tapfruit | bunch | 2000 |  | 6,58 | 2 |  |  | | | | | |
mtmuvz5mauryx | Jaune d'Oeuf Pasteurisé | Supplier Goods | Staple Stock | Tiramisu | 28 | Metro | bottle | 1000 |  | 10,31 | 2 |  |  | | | | | |
mtmuwuejxelaj | Blanc d'Oeuf Pasteurisé | Supplier Goods | Staple Stock | Tiramisu | 28 | Metro | bottle | 1000 |  | 6,88 | 2 |  |  | | | | | |
mtmuy91o8aeqr | Mangue Congelé | Supplier Goods | Staple Stock | Bingsu | 90 | Metro | pack | 1000 |  | 5,06 | 14 |  |  | | | | | |
mtmv2q54ggfns | Oeuf Calibre moyen | Supplier Goods | Staple Stock | Bibimbap | 28 | Metro | box | 4500 |  | 22,39 | 3 |  |  | | | | | |
mtmv4pkte83pp | Purée Mangue | Supplier Goods | Staple Stock | Bingsu | 90 | Metro | pack | 1000 |  | 8,53 | 12 |  |  | | | | | |
mtmv7eu5xmhub | Lait Concentré | Supplier Goods | Staple Stock | Bingsu | 90 | Metro | pack | 1000 |  | 5,51 | 16 |  |  | | | | | |
mtmvb2ynot3u4 | Glucose Atomisé | Supplier Goods | Staple Stock | Chicken | 360 | Internet | bag | 5000 |  | 44,28 | 10 |  |  | | | | | |
mtmvc9i99du0f | Miel Fleur | Supplier Goods | Staple Stock | BBQ Porc, BBQ DAK, BBQ Beef, Bibimbap | 360 | Metro | box | 1000 |  | 6,26 | 8 |  |  | | | | | |
mtmvdlovu4zpb | Pulco Jus Citron | Supplier Goods | Staple Stock | Bibimbap, Bingsu | 360 | Metro | bottle | 700 |  | 2,71 | 6 |  |  | | | | | |
mtmvf1nqksjee | Matcha | Supplier Goods | Staple Stock | Bibimbap, Bingsu | 360 | Metro | pack | 500 |  | 21,57 | 4 |  |  | | | | | |
mtmvigk70p399 | Cacao Poudre Sans sucre | Supplier Goods | Staple Stock | Tiramisu | 360 | Metro | box | 250 |  | 4,74 | 2 |  |  | | | | | |
mtmvkvcq7ydlp | Jus de Pomme | Supplier Goods | Staple Stock | Chicken, BBQ Porc, BBQ DAK, BBQ Beef, Kimchi Rouge, Kimchi Blanc | 360 | Metro | box | 6000 |  | 9,39 | 2 |  |  | | | | | |
mtmvn4lp7doh0 | Biscuit Cuillers | Supplier Goods | Staple Stock | Tiramisu | 60 | Metro | box | 1600 |  | 26,48 | 1 |  |  | | | | | |
mtmvp2thgzsjp | Glace Vanille | Supplier Goods | Staple Stock | Glace | 360 | Metro | box | 2500 |  | 7,78 | 8 |  |  | | | | | |
mtmvpw2rufb6e | Sorbet | Supplier Goods | Staple Stock | Sorbet | 360 | Metro | box | 2500 |  | 9,44 | 8 |  |  | | | | | |
mtmvr1azgl0tg | Sarrasin Kasha | Supplier Goods | Staple Stock | Courgette, Sorbet, Glace | 360 | Metro | pack | 1000 |  | 4,38 | 1 |  |  | | | | | |
mtmvsr6rvo1hh | Fruibon Mélange salade (Multi Grains) | Supplier Goods | Staple Stock | Sorbet | 180 | Metro | pack | 1000 |  | 10,19 | 2 |  |  | | | | | |
mtmvvkh1sq24d | Sucre Blanc poudre | Supplier Goods | Staple Stock |  | 180 | Metro | pack | 6000 |  | 6,97 | 3 |  |  | | | | | |
mtmvz62q559ue | SUCRE DE CANNE EN POUDRE BRUN SWB | Supplier Goods | Staple Stock | Sorbet | 360 | Leaf Market | pack | 300 |  | 1,76 | 4 |  |  | | | | | |
mtmw0clasmbru | Cannelle ENTIERE | Supplier Goods | Staple Stock | Sorbet | 360 | Metro | pack | 1000 |  | 10,17 | 1 |  |  | | | | | |
mtmw2b96tvkzc | Jujube Sec | Supplier Goods | Staple Stock | Sorbet | 360 | Leaf Market | pack | 454 |  | 4,32 | 2 |  |  | | | | | |
mtmw4crz8njlr | Farine T45 | Supplier Goods | Staple Stock | Chicken | 180 | Metro | pack | 10000 |  | 10,2 | 2 |  |  | | | | | |
mtmw5ml1m32w8 | Fécule PDT | Supplier Goods | Staple Stock | Chicken | 180 | Metro | bag | 5000 |  | 17,38 | 1 |  |  | | | | | |
mtmw6soto6cjn | Pignon PIN | Supplier Goods | Staple Stock | Courgette, BBQ Porc, BBQ DAK, BBQ Beef | 180 | Metro | pack | 1000 |  | 45,66 | 2 |  |  | | | | | |
mtmw7vs68imzh | Ketchup Heinz | Supplier Goods | Staple Stock | Chicken | 180 | Metro | bottle | 4000 |  | 14,44 | 1 |  |  | | | | | |
mtmw96khte5q9 | aro Vinaigre blanc 8° | Supplier Goods | Staple Stock | Jang-A-Chi | 360 | Metro | bottle | 10000 |  | 7,87 | 1 |  |  | | | | | |
mtmwa9m1ynjkw | Huile Friture | Supplier Goods | Staple Stock | Chicken | 180 | Metro | bottle | 5000 |  | 12,12 | 9 |  |  | | | | | |
mtmwbiw3iziox | Poivre Blanc moulu | Supplier Goods | Staple Stock |  | 360 | Metro | pack | 1000 |  | 23,12 | 2 |  |  | | | | | |
mtmzf60vx0jf0 | Sel Fin | Supplier Goods | Staple Stock |  | 360 | Metro | box | 5000 |  | 4,29 | 4 |  |  | | | | | |
mtmzh02wg5ixz | Lait entier | Supplier Goods | Staple Stock | Bingsu | 180 | Metro | box | 6000 |  | 7,71 | 3 |  |  | | | | | |
mtmziyh6x6vpc | Badoit Eau minérale gazeuse verre consigné | Supplier Goods | Staple Stock |  | 180 | Metro | box | 6000 |  | 16,54 | 1 |  |  | | | | | |
mtmzl1wx8qj29 | Coca-Cola goût original verre consigné | Supplier Goods | Staple Stock |  | 360 | Metro | box | 8000 |  | 28,52 | 1 |  |  | | | | | |
mtmzlrqlhdnpp | Coca-Cola sans sucres verre consigné | Supplier Goods | Staple Stock |  | 360 | Metro | box | 8000 |  | 26,25 | 1 |  |  | | | | | |
mtmznayiskiz7 | Evian Eau minérale verre consigné (Bte 1L) | Supplier Goods | Staple Stock |  | 360 | Metro | box | 12000 |  | 15,66 | 1 |  |  | | | | | |
mtmzpkjk25q44 | La French Ginger Beer | Supplier Goods | Staple Stock |  | 360 | Metro | box | 6000 |  | 30,67 | 1 |  |  | | | | | |
mtmzr4k9cq7uk | Couvercle bol à salade 500/750/1000 RPET | Supplier Goods | Staple Stock |  | 360 | Metro | pack |  | 50 | 3,19 | 4 |  |  | | | | | |
mtmzs31ftiqub | Bol à salade kraft 750 ml (Emporter) | Supplier Goods | Staple Stock |  | 360 | Metro | pack |  | 50 | 6,27 | 2 |  |  | | | | | |
mtmzsxmu98fgq | Bol à salade kraft 500 ml (Emporter) | Supplier Goods | Staple Stock |  | 360 | Metro | pack |  | 50 | 5,68 | 2 |  |  | | | | | |
mtmzu33gmocax | Film alimentaire 44 cm x300 m | Supplier Goods | Staple Stock |  | 360 | Metro | box |  | 4 | 30,85 | 1 |  |  | | | | | |
cfg-070 | Solia Pot sauce + couvercle 60 ml | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 100 | 3.59 |  |  |  | | | | | | 189688
cfg-071 | Useo Kit couverts 4 en 1 bois | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 50 | 8.35 |  |  |  | | | | | | 275939
cfg-072 | Sigma Bobine caisse enregistreuse 80x77x12 mm | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 10 | 23.94 |  |  |  | | | | | | 259413
cfg-073 | Sigma Bobine TPE 57x40x12 mm | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 20 | 13.24 |  |  |  | | | | | | 259417
cfg-074 | Sac avec poigné kraft 32x22x24 cm (Emporter) | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 50 | 6.83 |  |  |  | | | | | | 239596
cfg-075 | Sac en papier kraft 22x11x28 cm (Emporter) | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 50 | 5.02 |  |  |  | | | | | | 228590
cfg-076 | Sac bretelle plastique 26x12x45 cm (Emporter) | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 500 | 27.19 |  |  |  | | | | | | 194106
cfg-078 | Sac lisse de conservation 15x30 cm (Sous-vide) | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 100 | 18.94 |  |  |  | | | | | | 240677
cfg-079 | Sac lisse de conservation 30x40 cm (Sous-vide) | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 100 | 42.56 |  |  |  | | | | | | 240684
cfg-080 | Sac congélation liens 3 L x75 | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 3 | 6.39 |  |  |  | | | | | | 216522
cfg-081 | aro Eponge métallique | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 30 | 9.48 |  |  |  | | | | | | 245843
cfg-082 | aro Liquide vaisselle citron 1 L | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 3 | 4.51 |  |  |  | | | | | | 192689
cfg-083 | Gant en latex taille M | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 100 | 4.91 |  |  |  | | | | | | 210458
cfg-084 | Gant en latex taille S | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 100 | 5.06 |  |  |  | | | | | | 210442
cfg-085 | Sac poubelle avec liens 100 L | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 30 | 5.78 |  |  |  | | | | | | 225677
cfg-086 | Sac poubelle coulissant 50 L | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 30 | 3.39 |  |  |  | | | | | | 225661
cfg-087 | Lavette non-tissé bleu | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 10 | 3.54 |  |  |  | | | | | | 4555
cfg-088 | Solivaisselle lave-vaisselle cycle court (Kitchen / White) | Supplier Goods | Staple Stock |  |  | Metro | pack | 5000 | 1 | 20.77 |  |  |  | | | | | | 156415
cfg-089 | Solivaisselle rinçage séchage (Kitchen / Blue) | Supplier Goods | Staple Stock |  |  | Metro | pack | 5000 | 1 | 21.04 |  |  |  | | | | | | 4686
cfg-090 | Liquide lave-verre machine (Dishwasher Service) | Supplier Goods | Staple Stock |  |  | Metro | pack | 5000 | 1 | 21.33 |  |  |  | | | | | | 205046
cfg-091 | Détartrant anti-calcaire | Supplier Goods | Staple Stock |  |  | Metro | pack | 5000 | 1 | 12.83 |  |  |  | | | | | | 188621
cfg-092 | Gel décapant four | Supplier Goods | Staple Stock |  |  | Metro | pack | 5000 | 1 | 20.46 |  |  |  | | | | | | 7533
cfg-093 | Sanytol Désinfectant sol et surfaces | Supplier Goods | Staple Stock |  |  | Metro | pack | 5000 | 1 | 18.12 |  |  |  | | | | | | 149418
cfg-094 | Bobine 2 plis 450 feuilles (Sopalin) | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 6 | 11.14 |  |  |  | | | | | | 304082
cfg-095 | Papier toilette rouleau extra doux 140 feuilles | Supplier Goods | Staple Stock |  |  | Metro | pack |  | 24 | 10.44 |  |  |  | | | | | | 286331
cfg-096 | Gochujang | Supplier Goods | Staple Stock |  |  | Leaf market | box | 1000 |  | 5.65 |  |  |  | | | | | |
cfg-097 | Doenjang | Supplier Goods | Staple Stock |  |  | Leaf market | box | 500 |  | 3.52 |  |  |  | | | | | |
cfg-098 | Thé Prune | Supplier Goods | Staple Stock |  |  | Leaf market | pot | 480 |  | 5.37 |  |  |  | | | | | |
cfg-099 | Sauce soja corén | Supplier Goods | Staple Stock |  |  | Leaf market | bottle | 1000 |  | 3.83 |  |  |  | | | | | |
cfg-100 | Poudre piment Gros | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 1360 |  | 13.2 |  |  |  | | | | | |
cfg-101 | Poudre piment "Très Fin" | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 1000 |  | 7.84 |  |  |  | | | | | |
cfg-102 | Poudre Riz Gluant | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 400 |  | 1.57 |  |  |  | | | | | |
cfg-103 | Sésame blanc | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 434 |  | 2.71 |  |  |  | | | | | |
cfg-104 | Grain de Azuki | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 400 |  | 2.47 |  |  |  | | | | | |
cfg-105 | Sauce Poisson | Supplier Goods | Staple Stock |  |  | Leaf market | bottle | 1000 |  | 4.7 |  |  |  | | | | | |
cfg-106 | Huile de sésame (jia) (Bte 2.5L) | Supplier Goods | Staple Stock |  |  | Leaf market | bottle | 2300 |  | 24.61 |  |  |  | | | | | |
cfg-107 | Mirin (WADAKAN) 9% | Supplier Goods | Staple Stock |  |  | Leaf market | bottle | 1000 |  | 5.75 |  |  |  | | | | | |
cfg-108 | Shitake (entier) sec | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 500 |  | 14.72 |  |  |  | | | | | |
cfg-109 | Kombu sec | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 170 |  | 4.7 |  |  |  | | | | | |
cfg-110 | Poivre Sichuan | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 100 |  | 2.94 |  |  |  | | | | | |
cfg-111 | Riz (Miki) | Supplier Goods | Staple Stock |  |  | Leaf market | bag | 20000 |  | 44.5 |  |  |  | | | | | |
cfg-112 | Milkis | Supplier Goods | Staple Stock |  |  | Leaf market | carton |  | 30 | 30.3 |  |  |  | | | | | |
cfg-113 | Jus Poire Corén | Supplier Goods | Staple Stock |  |  | Leaf market | carton |  | 12 | 15.84 |  |  |  | | | | | |
cfg-114 | Jus Raisin Corén (bongbong) | Supplier Goods | Staple Stock |  |  | Leaf market | carton |  | 12 | 14.64 |  |  |  | | | | | |
cfg-115 | Aloe Wang | Supplier Goods | Staple Stock |  |  | Leaf market | carton |  | 20 | 32 |  |  |  | | | | | |
cfg-116 | CASS | Supplier Goods | Staple Stock |  |  | Leaf market | carton |  | 24 | 37.5 |  |  |  | | | | | |
cfg-117 | Asahi | Supplier Goods | Staple Stock |  |  | Leaf market | carton |  | 24 | 31.5 |  |  |  | | | | | |
`;

const SUP_CANON = { 'leaf market':'Leaf Market','metro':'Metro','tapfruit':'Tapfruit','beauvallet':'Beauvallet','acemart':'Acemart','internet':'Internet' };
const num = v => { v=(v||'').trim(); if(!v) return null; v=v.replace(',', '.').replace(/[^\d.\-]/g,''); const n=Number(v); return isNaN(n)?null:n; };
const canonSup = s => SUP_CANON[s.trim().toLowerCase()] || s.trim();

const items = [];
RAW.split('\n').map(l=>l.trim()).filter(Boolean).forEach(line=>{
  const c = line.split('|').map(x=>x.trim());
  const [id,name,category,subCategory,menus,shelf,suppliers,orderUnit,g,pcs,price,par,box,gbox,,,,,,ref] = c;
  const sup = (suppliers||'').split(',').map(s=>s.trim()).filter(Boolean).map(canonSup);
  if (!sup.length) return;              // <-- keep only items we order
  items.push({
    id, name, subCategory,
    suppliers: sup,
    orderUnit: orderUnit||'',
    gramsPerOrderUnit: num(g),
    piecesPerOrderUnit: num(pcs),
    unitPrice: num(price),
    parLevel: num(par),
    supplierRef: (ref||'').trim()
  });
});

fs.writeFileSync('./data/order-seed.json', JSON.stringify(items,null,0));
// stats
const bySup={}; items.forEach(i=>{ const s=i.suppliers[0]; bySup[s]=(bySup[s]||0)+1; });
console.log('ITEMS (with supplier): '+items.length);
console.log('BY PRIMARY SUPPLIER: '+JSON.stringify(bySup));
console.log('NO PRICE: '+items.filter(i=>i.unitPrice==null).map(i=>i.name).join(', ')||'none');
console.log('NO UNIT SIZE (no g & no pcs): '+(items.filter(i=>i.gramsPerOrderUnit==null&&i.piecesPerOrderUnit==null).map(i=>i.name).join(', ')||'none'));
