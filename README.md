# Desítka po setmění

Multiplayerová kvízovka ve stylu Desítky. Běží na Cloudflare Workers a Durable Objects, hráči se připojují přes odkaz nebo čtyřpísmenný kód a nikdo se nepřihlašuje.

## Nasazení (cca 5 minut)

Potřebuješ Node.js 18+ a účet na Cloudflare (stačí free plán).

```bash
cd desitka-cf
npm install
npx wrangler login      # otevře prohlížeč, potvrdíš přístup ke Cloudflare účtu
npx wrangler deploy
```

Po deployi Wrangler vypíše adresu, např. `https://desitka.<tvuj-subdomain>.workers.dev`. Tu pošli kamarádům.

### Vlastní doména (volitelné)
V Cloudflare dashboardu: Workers & Pages → desitka → Settings → Domains & Routes → Add → Custom domain (např. `desitka.lerstudio.cz`, doména musí být v Cloudflare).

## Lokální spuštění

```bash
npm run dev
```
Hra poběží na http://localhost:8787. Pro test víc hráčů otevři víc oken prohlížeče (jedno v anonymním režimu).

## Jak to funguje

- `public/index.html` – celá klientská aplikace (HTML/CSS/JS, bez buildu).
- `src/worker.js` – Worker: statické soubory + WebSocket `/ws/KÓD` → Durable Object `Room`.
- Každá místnost = jeden Durable Object. Drží stav hry, vyhodnocuje tahy a posílá stav všem hráčům.
  Správné odpovědi se do prohlížeče posílají až po odehrání položky nebo na konci kola, takže se nedá podvádět přes vývojářské nástroje.
- Místnost se sama smaže 48 hodin po poslední aktivitě.
- Hráč se po obnovení stránky nebo výpadku připojení vrátí na své místo (identita je uložená v prohlížeči).
- Když je hostitel offline, ovládání (další kolo, přeskočit hráče) převezme kdokoli z hráčů.

## Úprava otázek

Karty jsou v `src/cards.js`. Každá karta má otázku `q`, možnosti odpovědí `o` a přesně 10 položek `i` ve tvaru `["položka", "správná odpověď"]`. Správná odpověď musí být jedna z možností v `o`. Po úpravě znovu `npx wrangler deploy`.
