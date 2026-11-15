# Mimovrste+ (Napredno razvrščanje in filtri za Chrome)

Chrome razširitev (Manifest V3), ki v spletno trgovino **Mimovrste.com** naravno vgradi manjkajoče možnosti razvrščanja in filtriranja izdelkov. Vsi elementi uporabljajo izvorne Mimovrste CSS razrede in DOM strukturo, zato na strani sploh ni opazno, da gre za razširitev.

## Kaj omogoča?

### 1. Dodatni zavihki v vrstici za razvrščanje (na vrhu kategorij in iskanja)
Poleg izvornih možnosti (*Priporočamo, Najnižji ceni, Najvišji ceni, Priljubljenosti, Najbolj prodajano*) doda:
- **Največ ocen**: Razvrsti izdelke od tistega z največjim številom mnenj kupcev (`120x` -> `45x` -> `0x`) navzdol.
- **Najbolje ocenjeno**: Pametno razvrščanje po zvezdicah in številu ocen (izdelek z oceno 5★ in 80 ocenami se uvrsti pred izdelek z oceno 5★ in 1 oceno).
- **Največji popust**: Razvrsti izdelke po dejanskem odstotku znižanja (`%`), izračunanem iz stare in nove cene oz. značke *Prihranite*.
- **Največji prihranek (€)** *(izbirno v nastavitvah)*: Razvrsti izdelke po absolutnem prihranku v evrih.

### 2. Samodejno preiskovanje več strani kategorije
Ker Mimovrste na posamezni strani prikaže le ~24–36 izdelkov (in njegov zaledni strežnik ne podpira URL parametra za razvrščanje po ocenah), razširitev ob kliku na **Največ ocen** ali drug dodani zavihek:
1. **Takoj (0 ms)** razvrsti izdelke na trenutni strani.
2. **V ozadju samodejno prebere dodatne strani kategorije** (privzeto do 5 strani, nastavljivo v ikoni razširitve), združi vse izdelke brez podvajanja in jih razvrsti skupaj.
3. Ob številu artiklov (desno zgoraj) prikaže gumb **+ več strani**, s katerim lahko na zahtevo preiščete še naslednje strani kategorije.

### 3. Dodatni filtri v levem stolpcu (»Ocene in ponudba«)
Na vrh levega stolpca s filtri doda naravni sklop harmonike z živim števcem ujemajočih izdelkov `(N)`:
- **Samo ocenjeni izdelki** *(skrije izdelke brez ocen)*
- **Ocena 4★ ali več** *(prikaže le dobro ocenjene izdelke)*
- **Samo znižani izdelki** *(prikaže le izdelke z aktivnim popustom)*
- **Samo Mimovrste (brez partnerjev)** *(skrije izdelke zunanjih Marketplace prodajalcev `Partner: ...`, da vidite le izdelke, ki jih prodaja neposredno Mimovrste)*

---

## Namestitev v brskalnik Google Chrome / Brave / Edge

1. Odprite brskalnik Chrome in v naslovno vrstico vpišite:
   `chrome://extensions/`
2. V zgornjem desnem kotu vklopite stikalo **Način za razvijalce** (*Developer mode*).
3. Kliknite gumb **Naloži razpakirano** (*Load unpacked*) v zgornjem levem kotu.
4. Izberite mapo projekta:
   `C:\Users\Zan Dobaja\.gemini\antigravity\scratch\mimovrste-plus-extension`
5. Odprite poljubno kategorijo na **https://www.mimovrste.com** — novi zavihki za razvrščanje in stranski filtri se bodo samodejno pojavili na strani.
