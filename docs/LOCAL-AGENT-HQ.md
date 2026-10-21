# 本機部署：Agent HQ 3D Office（kaden-server）

呢個 fork（`wici-kt/Hermes3D`）跑喺 kaden-server，用嚟**取代**原本 `~/agent-hq/dashboard`
嗰個 2D Flask dashboard。原本 dashboard 只係 board + approve 掣，而家成個 agent fleet
變成一間可行入去嘅 3D 辦公室，同時保留 kanban 同 approval 流程。

## 點解有兩個「橋」（重要）

Hermes3D 同 `hermes serve` 之間有兩個互相衝突嘅限制，所以中間要兩個細代理：

1. **`hermes serve` 嘅 Host guard** — 佢只接受 `Host: localhost` 嘅 WebSocket upgrade
   （用 tailnet IP / 域名打過去會即刻 `403`），而且非 loopback bind 會變成「要登入」模式，
   `?token=` 直接失效。所以 backend 一定要綁 `127.0.0.1:9120`。
2. **Hermes3D 嘅 token 邊界** — Studio 只會喺 upstream URL 係**非 loopback** 時，才由
   server 端代連（token 由 server 注入，唔會落 browser）。如果 upstream 寫 `ws://127.0.0.1:9120`，
   browser 會自己直連、冇 token、永遠 timeout。

解法：`deploy/hermes3d-hostproxy.js` 聽一個**非 loopback** 位（`100.89.95.17:9121`），
轉去 `127.0.0.1:9120`，並將 `Host` 改寫成 `localhost`。於是：
Studio 見到非 loopback upstream → 走自己個 proxy（有 token）；backend 見到 Host: localhost → 放行。

同一個 script 再用一次做手機入口（`100.89.95.17:8792 → 127.0.0.1:8790`），
因為 Next.js 嘅 CSP 帶 `upgrade-insecure-requests`，喺純 HTTP 嘅 tailnet 位址上
browser 會將所有 subresource（同 WS）升級成 https 而同一個 port 冇 TLS，
結果頁面永遠停在「Connecting…」。入口代理用 `HOSTPROXY_STRIP_CSP_UPGRADE=1` 剝走嗰句 directive。
（localhost 係 exempt，所以本機一直冇事，只有遠端會中。）

## 三個 service（systemd --user）

| 單位 | 作用 | 聽邊 |
|---|---|---|
| `hermes3d-backend` | `hermes serve --host 127.0.0.1 --port 9120`，token 由 `~/.hermes/.env` 嘅 `HERMES3D_OFFICE_TOKEN` 讀 | `127.0.0.1:9120` |
| `hermes3d-hostproxy` | 改寫 Host 嘅橋，俾 Studio 用 | `100.89.95.17:9121` |
| `hermes3d-studio` | Hermes3D（production build） | `127.0.0.1:8790` |
| `hermes3d-frontdoor` | 手機 / 其他 tailnet 裝置入口 | `100.89.95.17:8792` |

開機自動起：已 `systemctl --user enable`。未做 `loginctl enable-linger kaden`
嘅話，未登入時唔會起（同原本 dashboard 一樣嘅限制）。

## 常用操作

```bash
systemctl --user status hermes3d-{backend,hostproxy,studio,frontdoor}
systemctl --user restart hermes3d-studio          # 改完 .env 或重新 build 之後
journalctl --user -u hermes3d-studio -n 50 --no-pager
cd ~/hermes3d && npm run build                     # 改咗前端之後要 rebuild（prod 唔會 hot reload）
```

網址：

- 本機：`http://127.0.0.1:8790/office`
- 手機 / tailnet：`http://100.89.95.17:8792/office`
- Task board：左上角 **KANBAN BOARD**（直接讀 `hermes` 嘅 cron / kanban / approvals）

## `.env`（`~/hermes3d/.env`，chmod 600，唔會 commit）

```
HERMES3D_GATEWAY_ADAPTER_TYPE=hermes-agent
HERMES3D_GATEWAY_URL=ws://100.89.95.17:9121     # 一定要非 loopback，否則 browser 直連冇 token
HERMES3D_GATEWAY_TOKEN=<~/.hermes/.env 嘅 HERMES3D_OFFICE_TOKEN>
PORT=8790
HOST=127.0.0.1
UPSTREAM_ALLOWLIST=100.89.95.17                  # production 必需要，空 list 會 block 所有 upstream
```

## 踩過嘅坑

- **`UPSTREAM_ALLOWLIST` 空 = 全部 block**。dev mode 冇事，一轉 production 就
  `studio.gateway_url_blocked`，訊息好易誤導成 URL 錯。
- **`EnvironmentFile` 會覆蓋 `Environment=`**（systemd 後者勝），所以 `PORT` 要寫在 `.env`，
  唔係寫在 unit 檔，否則會見到「Open in browser: http://localhost:3000」而去錯 port。
- **prod 改前端要 `npm run build`**，`npm run dev` 唔會影響 systemd 起嘅 prod 版。
- **舊 `agent-hq-dashboard` 係 Docker container**（`agent-hq:latest`，host network 佔 8790/8791）。
  已 `docker update --restart=no` + `docker stop`，container 冇 delete，可以隨時 `docker start` 回滾。

## 一個 agent profile = 一個角色

`hermes serve` 會將每個 profile 映一個角色：`default / builder / creative / researcher /
reviewer / scriptwriter / social` 七個。想改名或者加減，係改 Hermes profile，唔係改 Hermes3D。
