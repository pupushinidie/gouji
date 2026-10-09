# 够级

够级的网页联机版：青岛的四副牌扑克，6 个座位分两个联邦 3 对 3（隔座是队友，正对面是对头），开局时空座由人机（咕噜一号、二号……）补满。线上路径 https://gulugagame.com/gouji/ 。

规则书：`~/Desktop/游戏规则/够级.md`，补充和勘误：`~/Desktop/游戏规则/够级-补充.md`。开工拍板：`~/projects/pipeline/games/gouji/decisions/kickoff.json`。

> 状态：脚手架（从斗地主 doudizhu@468d826 复制）。规则引擎、服务器、规则说明正在写，写完后这份 README 会补全。

常用命令：`npm run dev`（服务 3021、网页 5292；另起一套用 `WEB_PORT=… SERVER_PORT=… npm run dev`）、`npm test`、`npm run typecheck`、`BASE_PATH=/gouji/ npm run build`。
