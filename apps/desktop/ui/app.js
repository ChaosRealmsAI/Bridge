const DEFAULT_API="https://api.bridge.chaos-realms.cc";
const SELFHOST_HELP_URL="";// TODO: 填入「如何添加自建服务器」帮助页链接
if(window.ipc)document.documentElement.classList.add("app");
const ICON_BURN=`<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254" role="img" aria-labelledby="title desc"><title id="title">Burn Token Mark</title><desc id="desc">Pure vector burn-token mark traced from foreground geometry. No raster image is embedded.</desc><defs><linearGradient id="burnGradient" x1="0" y1="120" x2="0" y2="1090" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffc400"/><stop offset="0.36" stop-color="#ff9300"/><stop offset="0.66" stop-color="#ff5a00"/><stop offset="1" stop-color="#f20b1f"/></linearGradient><radialGradient id="emberGradient" cx="32%" cy="24%" r="72%"><stop offset="0" stop-color="#fff3a5"/><stop offset="0.42" stop-color="#ff6e00"/><stop offset="1" stop-color="#f0081c"/></radialGradient><filter id="softLift" x="-18%" y="-18%" width="136%" height="136%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#ff5a00" flood-opacity="0.10"/></filter></defs><path d="M 846 790.5 L 844.5 789 L 844.5 769 L 840.5 740 L 831.5 711 L 814.5 677 L 784.5 637 L 759 612.5 L 733 594.5 L 711 583.5 L 688 575.5 L 646 567.5 L 609 567.5 L 578 572.5 L 545 583.5 L 503 607.5 L 467.5 640 L 451.5 660 L 434.5 686 L 423.5 708 L 414.5 735 L 409.5 763 L 408.5 788 L 407 789.5 L 398.5 779 L 383.5 750 L 373.5 710 L 374.5 674 L 380.5 650 L 385.5 639 L 388 637.5 L 391.5 652 L 395.5 659 L 400 663.5 L 409 666.5 L 415 664.5 L 419.5 660 L 423.5 649 L 423.5 626 L 413.5 565 L 414.5 538 L 421.5 508 L 430.5 488 L 443 470.5 L 444.5 473 L 439.5 498 L 443.5 525 L 453.5 546 L 477 574.5 L 489.5 557 L 493.5 538 L 491.5 515 L 479.5 480 L 473.5 453 L 472.5 426 L 477.5 396 L 487.5 369 L 505.5 339 L 531 311.5 L 549 299.5 L 551.5 301 L 542.5 313 L 533.5 332 L 527.5 358 L 527.5 384 L 531.5 406 L 544.5 439 L 564.5 469 L 592 495.5 L 608 506.5 L 614 509.5 L 615.5 508 L 590.5 480 L 571.5 446 L 563.5 422 L 561.5 410 L 560.5 379 L 563.5 360 L 571.5 336 L 582.5 314 L 622.5 254 L 635.5 223 L 639.5 199 L 638.5 177 L 631.5 151 L 622.5 134 L 624 132.5 L 636 141.5 L 655.5 161 L 673.5 185 L 689.5 217 L 696.5 244 L 697.5 271 L 695.5 288 L 687.5 316 L 673.5 352 L 668.5 376 L 668.5 404 L 671.5 420 L 683.5 450 L 698.5 472 L 719 490.5 L 720.5 489 L 712.5 475 L 706.5 454 L 706.5 426 L 711.5 409 L 718.5 395 L 734.5 372 L 742.5 354 L 744.5 345 L 744.5 326 L 740.5 313 L 742 311.5 L 748.5 318 L 758.5 336 L 764.5 357 L 764.5 381 L 753.5 429 L 754.5 454 L 762.5 482 L 785.5 526 L 790.5 540 L 793.5 554 L 792.5 581 L 794 582.5 L 803.5 565 L 808.5 550 L 812.5 523 L 811.5 503 L 807.5 485 L 802.5 471 L 793.5 455 L 795 453.5 L 803.5 460 L 827.5 486 L 839.5 506 L 847.5 525 L 853.5 550 L 853.5 584 L 845.5 616 L 829.5 652 L 828.5 663 L 830.5 671 L 835 676.5 L 840 678.5 L 848 676.5 L 855.5 669 L 860.5 659 L 863.5 641 L 866 637.5 L 873.5 653 L 878.5 672 L 880.5 699 L 878.5 719 L 872.5 742 L 861.5 767 L 846 790.5 Z M 777 912.5 L 768 912.5 L 764 910.5 L 758.5 905 L 755.5 895 L 756.5 890 L 764.5 878 L 776.5 853 L 786.5 813 L 786.5 774 L 783.5 757 L 775.5 732 L 764.5 710 L 751.5 691 L 724 663.5 L 706 651.5 L 688 642.5 L 671 636.5 L 645 631.5 L 622 630.5 L 603 632.5 L 565 643.5 L 529 665.5 L 503.5 691 L 493.5 705 L 480.5 729 L 472.5 751 L 467.5 773 L 467.5 818 L 473.5 845 L 476.5 851 L 476.5 860 L 469 869.5 L 464 871.5 L 456 871.5 L 450 868.5 L 444.5 861 L 435.5 827 L 432.5 798 L 433.5 775 L 437.5 752 L 446.5 723 L 461.5 693 L 477.5 670 L 506 640.5 L 536 619.5 L 570 604.5 L 605 596.5 L 650 596.5 L 676 601.5 L 712 615.5 L 748 639.5 L 775.5 668 L 794.5 696 L 807.5 723 L 812.5 738 L 819.5 773 L 819.5 814 L 812.5 849 L 805.5 869 L 793.5 894 L 785.5 907 L 777 912.5 Z M 700 762.5 L 552 762.5 L 547 760.5 L 541.5 755 L 538.5 743 L 541.5 735 L 552 727.5 L 701 727.5 L 708 731.5 L 712.5 737 L 714.5 748 L 711.5 755 L 707 759.5 L 700 762.5 Z M 631 915.5 L 619 914.5 L 613.5 910 L 609.5 902 L 609.5 796 L 611.5 790 L 622 781.5 L 631 781.5 L 635 783.5 L 640.5 789 L 643.5 800 L 642.5 905 L 637 912.5 L 631 915.5 Z" fill="url(#burnGradient)" fill-rule="evenodd" filter="url(#softLift)"/><g id="tokenParticles"><circle cx="458.84" cy="930.55" r="9.96" fill="#fa4515"/><circle cx="508.84" cy="935.75" r="16.53" fill="#f93d14"/><circle cx="431.5" cy="893.58" r="7.68" fill="#fb5516"/><circle cx="487.62" cy="889.25" r="14.25" fill="#fb5411"/><circle cx="585.8" cy="945.1" r="8.03" fill="#f93819"/><circle cx="549.71" cy="915.15" r="7.64" fill="#fc521b"/><circle cx="664.61" cy="948.85" r="5.77" fill="#f93227"/><circle cx="821.93" cy="890.58" r="7.35" fill="#f52820"/><circle cx="743.34" cy="927.56" r="14.9" fill="#f6221d"/><circle cx="798.18" cy="927.93" r="8.38" fill="#f21f21"/><circle cx="704.38" cy="952.55" r="8.43" fill="#f6251e"/><circle cx="765.07" cy="964.17" r="10.6" fill="#f31f21"/><circle cx="732.84" cy="991.67" r="10.24" fill="#f31f21"/><circle cx="630.21" cy="969.2" r="9.52" fill="#f5291c"/><circle cx="675.91" cy="990.16" r="16.04" fill="#f4201f"/><circle cx="701.73" cy="1030.98" r="8.01" fill="#f31e21"/><circle cx="656.32" cy="1063.28" r="7.53" fill="#f42125"/><circle cx="634.73" cy="1022.19" r="12.45" fill="#f31d1e"/><circle cx="595.7" cy="1056.79" r="7.83" fill="#f22122"/><circle cx="592.83" cy="993.18" r="13.33" fill="#f4241c"/><circle cx="553.19" cy="1024.61" r="10.51" fill="#f6271e"/><circle cx="515.12" cy="992.79" r="8.03" fill="#f7321e"/><circle cx="474.98" cy="972.88" r="7.38" fill="#f83b1b"/><circle cx="549.98" cy="967.69" r="13.65" fill="#f7311a"/></g></svg>`;
const BASE_PRODUCTS=[
  {id:"panda-burn",name:"Burn",origin:"https://token-burn.com",web_url:"https://token-burn.com/authorize",initials:"B",color:"linear-gradient(150deg,#201716,#3a1813)",icon:ICON_BURN,accounts:[],connected:false,connection:"offline"}
];
const LANG_OPTIONS=[
  ["auto","跟随系统"],["zh-CN","简体中文"],["zh-TW","繁體中文"],["en","English"],["ja","日本語"]
];
const TEXT={
  "zh-CN":{products:"产品",settings:"设置",notConnected:"未连接",accounts:"{n} 个账号",open:"打开",auth:"授权",conn:"连接",delete:"删除",cancel:"取消",confirmDelete:"删除 {name}？",deleteDesc:"该账号将无法再使用{device}的 AI。",useOnMac:"把 {name} 接到{device}",emptySub:"在 {name} 网页登录后点「连接这台电脑」，回到这里允许即可，之后连接会自动维持。",emptyHint:"登录后点「连接这台电脑」，回到这里确认即可",waiting:"已就绪，等待连接请求…",netbar:"实时通道重连中，已切到轮询 — 任务会继续处理",launch:"开机时启动",appearance:"外观",system:"跟随系统",light:"浅色",dark:"深色",language:"语言",cloud:"云端地址",deny:"拒绝",allow:"允许连接",wants:"{name} 想连接{device}",opened:"已打开网页",paused:"已暂停授权",resumed:"已恢复授权",removed:"已删除",failed:"操作失败",connected:"已连接",reconnecting:"重连中",idle:"未连接",engineRunning:"本机引擎 · 运行中",engineReconnect:"云端 · 重连中…",accountsN:"账号 · {n}"},
  "zh-TW":{products:"產品",settings:"設定",notConnected:"未連接",accounts:"{n} 個帳號",open:"開啟",auth:"授權",conn:"連接",delete:"刪除",cancel:"取消",confirmDelete:"刪除 {name}？",deleteDesc:"該帳號將無法再使用{device}的 AI。",useOnMac:"把 {name} 接到{device}",emptySub:"在 {name} 網頁登入後點「連接這台電腦」，回到這裡允許即可，之後連接會自動維持。",emptyHint:"登入後點「連接這台電腦」，回到這裡確認即可",waiting:"已就緒，等待連接請求…",netbar:"即時通道重連中，已切到輪詢 — 任務會繼續處理",launch:"開機時啟動",appearance:"外觀",system:"跟隨系統",light:"淺色",dark:"深色",language:"語言",cloud:"雲端地址",deny:"拒絕",allow:"允許連接",wants:"{name} 想連接{device}",opened:"已開啟網頁",paused:"已暫停授權",resumed:"已恢復授權",removed:"已刪除",failed:"操作失敗",connected:"已連接",reconnecting:"重連中",idle:"未連接",engineRunning:"本機引擎 · 運行中",engineReconnect:"雲端 · 重連中…",accountsN:"帳號 · {n}"},
  en:{products:"Products",settings:"Settings",notConnected:"Not connected",accounts:"{n} accounts",open:"Open",auth:"Authorization",conn:"Connection",delete:"Delete",cancel:"Cancel",confirmDelete:"Delete {name}?",deleteDesc:"This account will no longer use the AI on {device}.",useOnMac:"Connect {name} to {device}",emptySub:"Sign in to {name} on the web, choose Connect this computer, then come back here to allow. The connection stays up automatically.",emptyHint:"Sign in, choose Connect this computer, then return here to confirm",waiting:"Ready — waiting for connection requests…",netbar:"Realtime reconnecting; polling fallback is active. Tasks continue processing.",launch:"Launch at login",appearance:"Appearance",system:"System",light:"Light",dark:"Dark",language:"Language",cloud:"Cloud address",deny:"Deny",allow:"Allow",wants:"{name} wants to connect to {device}",opened:"Opened web",paused:"Authorization paused",resumed:"Authorization restored",removed:"Deleted",failed:"Action failed",connected:"Connected",reconnecting:"Reconnecting",idle:"Not connected",engineRunning:"Local engine · running",engineReconnect:"Cloud · reconnecting…",accountsN:"Accounts · {n}"},
  ja:{products:"製品",settings:"設定",notConnected:"未接続",accounts:"{n} アカウント",open:"開く",auth:"承認",conn:"接続",delete:"削除",cancel:"キャンセル",confirmDelete:"{name} を削除しますか？",deleteDesc:"このアカウントは{device}の AI を使えなくなります。",useOnMac:"{name} を{device}に接続",emptySub:"{name} のウェブでログインし「このコンピューターに接続」を選び、ここに戻って許可します。接続は自動で維持されます。",emptyHint:"ログインして「このコンピューターに接続」を選び、ここに戻って確認します",waiting:"準備完了 — 接続リクエスト待機中…",netbar:"リアルタイム接続を再接続中です。ポーリングで処理を継続しています。",launch:"ログイン時に起動",appearance:"外観",system:"システム",light:"ライト",dark:"ダーク",language:"言語",cloud:"クラウドアドレス",deny:"拒否",allow:"許可",wants:"{name} が{device}に接続しようとしています",opened:"ウェブを開きました",paused:"承認を一時停止しました",resumed:"承認を再開しました",removed:"削除しました",failed:"操作に失敗しました",connected:"接続済み",reconnecting:"再接続中",idle:"未接続",engineRunning:"ローカルエンジン · 稼働中",engineReconnect:"クラウド · 再接続中…",accountsN:"アカウント · {n}"}
};
Object.assign(TEXT["zh-CN"],{server:"服务器",serverProfile:"服务器 Profile",addServer:"添加服务器",pairServer:"配对服务器",pairingToken:"配对 Token",serverUrl:"http(s)://你的 Bridge API",refresh:"刷新",official:"官方",custom:"自托管",serverAdded:"服务器已添加",serverSelected:"服务器已切换",serverRemoved:"服务器已移除",serverRefreshed:"服务器已刷新",general:"通用",cloudGroup:"云端"});
Object.assign(TEXT["zh-TW"],{server:"伺服器",serverProfile:"伺服器 Profile",addServer:"新增伺服器",pairServer:"配對伺服器",pairingToken:"配對 Token",serverUrl:"http(s)://你的 Bridge API",refresh:"重新整理",official:"官方",custom:"自託管",serverAdded:"伺服器已新增",serverSelected:"伺服器已切換",serverRemoved:"伺服器已移除",serverRefreshed:"伺服器已重新整理",general:"一般",cloudGroup:"雲端"});
Object.assign(TEXT.en,{server:"Server",serverProfile:"Server profile",addServer:"Add server",pairServer:"Pair server",pairingToken:"Pairing Token",serverUrl:"http(s)://your Bridge API",refresh:"Refresh",official:"Official",custom:"Self-hosted",serverAdded:"Server added",serverSelected:"Server switched",serverRemoved:"Server removed",serverRefreshed:"Server refreshed",general:"General",cloudGroup:"Cloud"});
Object.assign(TEXT.ja,{server:"サーバー",serverProfile:"サーバー Profile",addServer:"サーバー追加",pairServer:"サーバーをペアリング",pairingToken:"Pairing Token",serverUrl:"http(s)://your Bridge API",refresh:"更新",official:"公式",custom:"セルフホスト",serverAdded:"サーバーを追加しました",serverSelected:"サーバーを切り替えました",serverRemoved:"サーバーを削除しました",serverRefreshed:"サーバーを更新しました",general:"一般",cloudGroup:"クラウド"});
Object.assign(TEXT["zh-CN"],{pausedTag:"已暂停",engineStarting:"本机引擎 · 启动中…",engineUnavailable:"本机引擎 · 状态读取失败"});
Object.assign(TEXT["zh-TW"],{pausedTag:"已暫停",engineStarting:"本機引擎 · 啟動中…",engineUnavailable:"本機引擎 · 狀態讀取失敗"});
Object.assign(TEXT.en,{pausedTag:"Paused",engineStarting:"Local engine · starting…",engineUnavailable:"Local engine · status unavailable"});
Object.assign(TEXT.ja,{pausedTag:"停止中",engineStarting:"ローカルエンジン · 起動中…",engineUnavailable:"ローカルエンジン · 状態を取得できません"});
Object.assign(TEXT["zh-CN"],{connectionOff:"已关闭",connectionPaused:"已关闭连接",connectionResumed:"已恢复连接"});Object.assign(TEXT["zh-TW"],{connectionOff:"已關閉",connectionPaused:"已關閉連接",connectionResumed:"已恢復連接"});Object.assign(TEXT.en,{connectionOff:"Off",connectionPaused:"Connection turned off",connectionResumed:"Connection restored"});Object.assign(TEXT.ja,{connectionOff:"オフ",connectionPaused:"接続をオフにしました",connectionResumed:"接続を再開しました"});
Object.assign(TEXT["zh-CN"],{authorizing:"处理中…"});
Object.assign(TEXT["zh-TW"],{authorizing:"處理中…"});
Object.assign(TEXT.en,{authorizing:"Processing…"});
Object.assign(TEXT.ja,{authorizing:"処理中…"});
Object.assign(TEXT["zh-CN"],{aboutAuthor:"关于作者"});Object.assign(TEXT["zh-TW"],{aboutAuthor:"關於作者"});Object.assign(TEXT.en,{aboutAuthor:"About"});Object.assign(TEXT.ja,{aboutAuthor:"作者について"});
Object.assign(TEXT["zh-CN"],{addServerTitle:"添加自托管服务器",addServerDesc:"连接你自己部署的 Bridge 服务器，数据只在你和服务器之间流转。",serverUrlLabel:"服务器地址",pairTokenHint:"在你的 Bridge 服务器上生成一次性配对 Token，粘贴到这里完成配对。",pairingBusy:"配对中…",healthOnline:"在线",healthDegraded:"重连中",healthOffline:"离线",healthChecking:"检测中…",healthUnknown:"未检测",currentTag:"当前",officialTag:"官方",selfhostTag:"自托管",recheck:"重新检测",removeServerConfirm:"移除 {name}？",removeServerDesc:"将从这台电脑删除该服务器配置，已配对的设备凭证也会失效。"});
Object.assign(TEXT["zh-TW"],{addServerTitle:"新增自託管伺服器",addServerDesc:"連接你自己部署的 Bridge 伺服器，資料只在你與伺服器之間流轉。",serverUrlLabel:"伺服器位址",pairTokenHint:"在你的 Bridge 伺服器上產生一次性配對 Token，貼到這裡完成配對。",pairingBusy:"配對中…",healthOnline:"線上",healthDegraded:"重新連線中",healthOffline:"離線",healthChecking:"檢測中…",healthUnknown:"未檢測",currentTag:"目前",officialTag:"官方",selfhostTag:"自託管",recheck:"重新檢測",removeServerConfirm:"移除 {name}？",removeServerDesc:"將從這台電腦刪除該伺服器設定，已配對的裝置憑證也會失效。"});
Object.assign(TEXT.en,{addServerTitle:"Pair a self-hosted server",addServerDesc:"Connect to your own Bridge server — traffic stays between you and that server.",serverUrlLabel:"Server address",pairTokenHint:"Generate a one-time Pairing Token on your Bridge server, then paste it here.",pairingBusy:"Pairing…",healthOnline:"Online",healthDegraded:"Reconnecting",healthOffline:"Offline",healthChecking:"Checking…",healthUnknown:"Not checked",currentTag:"Active",officialTag:"Official",selfhostTag:"Self-hosted",recheck:"Re-check",removeServerConfirm:"Remove {name}?",removeServerDesc:"This removes the server from this computer; its paired device credential is revoked."});
Object.assign(TEXT.ja,{addServerTitle:"セルフホストサーバーを追加",addServerDesc:"自分で運用する Bridge サーバーに接続します。通信はあなたとサーバーの間だけで完結します。",serverUrlLabel:"サーバーアドレス",pairTokenHint:"Bridge サーバーでワンタイムのペアリング Token を生成し、ここに貼り付けてください。",pairingBusy:"ペアリング中…",healthOnline:"オンライン",healthDegraded:"再接続中",healthOffline:"オフライン",healthChecking:"確認中…",healthUnknown:"未確認",currentTag:"現在",officialTag:"公式",selfhostTag:"セルフホスト",recheck:"再確認",removeServerConfirm:"{name} を削除しますか？",removeServerDesc:"このコンピューターからサーバー設定を削除します。ペアリング済みの端末資格情報も無効になります。"});
Object.assign(TEXT["zh-CN"],{expandServers:"显示全部 {n} 台",collapseServers:"收起",selfhostHelp:"如何自建服务器"});
Object.assign(TEXT["zh-TW"],{expandServers:"顯示全部 {n} 台",collapseServers:"收起",selfhostHelp:"如何自建伺服器"});
Object.assign(TEXT.en,{expandServers:"Show all {n}",collapseServers:"Show less",selfhostHelp:"How to self-host"});
Object.assign(TEXT.ja,{expandServers:"すべて表示（{n}）",collapseServers:"折りたたむ",selfhostHelp:"サーバーを自前で立てるには"});
Object.assign(TEXT["zh-CN"],{devicePresent:"设备在线",devicePaired:"已配对",deviceUnpaired:"未配对",authActive:"已授权",authNone:"未授权",engineStopped:"本机引擎已停止",adapterMissing:"Adapter 缺失",engineReady:"本机就绪",transportRealtime:"实时通道",transportPolling:"轮询兜底",transportIdle:"传输空闲",healthIncompatible:"不兼容"});
Object.assign(TEXT["zh-TW"],{devicePresent:"裝置線上",devicePaired:"已配對",deviceUnpaired:"未配對",authActive:"已授權",authNone:"未授權",engineStopped:"本機引擎已停止",adapterMissing:"Adapter 缺失",engineReady:"本機就緒",transportRealtime:"即時通道",transportPolling:"輪詢備援",transportIdle:"傳輸閒置",healthIncompatible:"不相容"});
Object.assign(TEXT.en,{devicePresent:"Device present",devicePaired:"Paired",deviceUnpaired:"Unpaired",authActive:"Authorized",authNone:"Not authorized",engineStopped:"Engine stopped",adapterMissing:"Adapter missing",engineReady:"Local ready",transportRealtime:"Realtime",transportPolling:"Polling fallback",transportIdle:"Transport idle",healthIncompatible:"Incompatible"});
Object.assign(TEXT.ja,{devicePresent:"デバイスオンライン",devicePaired:"ペアリング済み",deviceUnpaired:"未ペアリング",authActive:"承認済み",authNone:"未承認",engineStopped:"エンジン停止",adapterMissing:"Adapter なし",engineReady:"ローカル準備完了",transportRealtime:"リアルタイム",transportPolling:"ポーリング代替",transportIdle:"転送待機",healthIncompatible:"非対応"});
Object.assign(TEXT["zh-CN"],{probeHealth:"health",probeDiagnostics:"diagnostics",probeFailedAt:"失败阶段",serverProbeTimedOut:"检测超时，请重新检测"});Object.assign(TEXT["zh-TW"],{probeHealth:"health",probeDiagnostics:"diagnostics",probeFailedAt:"失敗階段",serverProbeTimedOut:"檢測逾時，請重新檢測"});Object.assign(TEXT.en,{probeHealth:"health",probeDiagnostics:"diagnostics",probeFailedAt:"failed at",serverProbeTimedOut:"Check timed out. Re-check the server."});Object.assign(TEXT.ja,{probeHealth:"health",probeDiagnostics:"diagnostics",probeFailedAt:"失敗段階",serverProbeTimedOut:"確認がタイムアウトしました。再確認してください"});
Object.assign(TEXT["zh-CN"],{localComputer:"本机电脑",computerName:"电脑名称",computerModel:"机型",computerSystem:"系统",computerFingerprint:"本机指纹"});
Object.assign(TEXT["zh-TW"],{localComputer:"本機電腦",computerName:"電腦名稱",computerModel:"機型",computerSystem:"系統",computerFingerprint:"本機指紋"});
Object.assign(TEXT.en,{localComputer:"Local Computer",computerName:"Computer name",computerModel:"Model",computerSystem:"System",computerFingerprint:"Local fingerprint"});
Object.assign(TEXT.ja,{localComputer:"ローカルコンピューター",computerName:"コンピューター名",computerModel:"モデル",computerSystem:"システム",computerFingerprint:"ローカル指紋"});
Object.assign(TEXT["zh-CN"],{localComputerUnavailable:"本机信息暂不可用"});
Object.assign(TEXT["zh-TW"],{localComputerUnavailable:"本機資訊暫不可用"});
Object.assign(TEXT.en,{localComputerUnavailable:"Local computer unavailable"});
Object.assign(TEXT.ja,{localComputerUnavailable:"ローカル情報を取得できません"});
const OFFICIAL_PROFILE={id:"official",name:"Official Bridge Cloud",api_base:DEFAULT_API,web_origin:"https://bridge.chaos-realms.cc",source:"official",products:BASE_PRODUCTS.map(clone)};
const ui={view:"product",selected:"panda-burn",products:BASE_PRODUCTS.map(clone),settings:{launch_at_login:true,appearance:"auto",language:"auto",api_base:DEFAULT_API,cloud_profiles:[clone(OFFICIAL_PROFILE)],selected_cloud_profile_id:"official"},pending:null,status:null,booting:true,statusError:null,health:{},serverBusy:{},serverProbeBackoff:{},serverProbeBackoffTimers:{},serverProbeTimers:{},serverProbeTokens:{},serverSheet:null,serverListExpanded:false};
const SERVER_PROBE_SUCCESS_COOLDOWN_MS=2500,SERVER_PROBE_FAILURE_BACKOFF_MS=30000,SERVER_PROBE_UI_TIMEOUT_MS=8000;
const mq=window.matchMedia("(prefers-color-scheme: dark)");
const ipcState={seq:0,calls:new Map()};
window.PandaBridge={
  call(command,params={}){
    const id=String(++ipcState.seq);
    const timeoutMs=command==="status"?5000:15000;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        const item=ipcState.calls.get(id); if(!item)return;
        ipcState.calls.delete(id);
        item.reject(new Error(`${command} timed out`));
      },timeoutMs);
      ipcState.calls.set(id,{
        resolve(value){clearTimeout(timer);resolve(value)},
        reject(error){clearTimeout(timer);reject(error)}
      });
      try{window.ipc.postMessage(JSON.stringify({id,command,params}))}
      catch(error){ipcState.calls.delete(id);clearTimeout(timer);reject(error)}
    });
  },
  receive(message){
    if(message.type==="response"){
      const item=ipcState.calls.get(message.id); if(!item)return;
      ipcState.calls.delete(message.id);
      message.ok?item.resolve(message.result):item.reject(new Error(message.error||"desktop command failed"));
      return;
    }
    if(message.type==="event"&&message.event==="deep_link")handleDeepLink(message.url).catch((error)=>showDeepLinkError(message.url,error));
    if(message.type==="event"&&message.event==="refresh")refresh().catch(()=>{});
    if(message.type==="event"&&message.event==="focus")onWindowFocus();
  }
};
function clone(x){return JSON.parse(JSON.stringify(x))}
function sysLang(){const n=(navigator.language||"en").toLowerCase();if(n.startsWith("zh"))return /tw|hk|hant|mo/.test(n)?"zh-TW":"zh-CN";if(n.startsWith("ja"))return"ja";return"en"}
function lang(){return ui.settings.language==="auto"?sysLang():ui.settings.language}
function platformKind(){const q=new URLSearchParams(location.search).get("os");if(q)return q;const p=((navigator.userAgent||"")+" "+(navigator.platform||"")).toLowerCase();if(p.includes("win"))return"windows";if(p.includes("mac"))return"mac";return"computer"}
const DEVICE_LABELS={
  "zh-CN":{mac:"这台 Mac",windows:"这台 Windows 电脑",computer:"这台电脑"},
  "zh-TW":{mac:"這台 Mac",windows:"這台 Windows 電腦",computer:"這台電腦"},
  en:{mac:"this Mac",windows:"this Windows PC",computer:"this computer"},
  ja:{mac:"この Mac",windows:"この Windows PC",computer:"このコンピューター"}
};
function deviceLabel(){const labels=DEVICE_LABELS[lang()]||DEVICE_LABELS["zh-CN"];return labels[platformKind()==="windows"?"windows":platformKind()==="mac"?"mac":"computer"]||labels.computer}
function t(k,vars){let s=(TEXT[lang()]||TEXT["zh-CN"])[k]||k;const merged={device:deviceLabel(),...(vars||{})};for(const key in merged)s=s.split("{"+key+"}").join(merged[key]);return s}
function esc(x){return String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function applyTheme(){const mode=ui.settings.appearance||"auto";document.documentElement.dataset.theme=(mode==="dark"||(mode==="auto"&&mq.matches))?"dark":"light";document.documentElement.dataset.os=platformKind()==="windows"?"windows":"mac"}
if(mq.addEventListener)mq.addEventListener("change",applyTheme);
const LOGO_BRIDGE=`<svg viewBox="0 0 1254 1254" role="img" aria-labelledby="title desc" class="full bridgeOnlyMark" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"><path fill="currentColor" d="M 474 363 L 518 363 L 518 437.5 L 525 463.5 L 536 487.5 Q 548.93 511.07 568.5 528 Q 580.63 538.38 596.5 545 L 614.5 550 L 630.5 551 L 631.5 550 L 639.5 550 L 652.5 547 L 668.5 540 Q 687.34 528.84 701 512.5 Q 723.19 486.69 734 449.5 L 734 445.5 L 736 439.5 L 736 363 L 780 363 L 780 433.5 L 800 476.5 L 814 499.5 Q 833.6 527.9 858.5 551 Q 879.51 570.49 904.5 586 L 946.5 609 L 971.5 620 L 990.5 626 L 993.5 628 L 996.5 628 L 1006.5 632 L 1033.5 639 L 1038 639 L 1027.5 656 L 1023.5 656 L 1003.5 651 L 978.5 643 L 948.5 631 L 921.5 618 L 877.5 591 Q 854.02 574.48 834 554.5 Q 802.88 523.12 780.5 483 L 780 581.5 L 794.5 592 L 827.5 611 L 875.5 633 L 880.5 634 L 904.5 644 L 947.5 658 L 993.5 670 L 997.5 670 L 1002.5 672 L 1020 675 L 998 732.5 L 979.5 775 Q 970.99 738.51 948.5 716 Q 937.18 704.32 921.5 697 L 904.5 692 L 888.5 691 L 887.5 692 L 879.5 692 L 865.5 696 Q 846.8 703.8 834 717.5 L 823 730.5 L 810 753.5 L 803 772.5 L 797.5 799 L 797 624.5 L 794.5 622 L 780 614 L 780 895.5 L 779.5 896 L 737.5 896 L 736 896.5 L 736 690.5 Q 733.5 689 735 683.5 L 729 660.5 L 722 645.5 Q 711.03 626.47 694.5 613 Q 678.81 599.69 656.5 593 L 643.5 590 L 636.5 590 L 635.5 589 L 619.5 589 L 618.5 590 L 611.5 590 L 610.5 591 L 601.5 592 L 584.5 598 Q 563.67 607.67 549 623.5 Q 536.23 637.23 528 655.5 L 522 672.5 L 520 686.5 L 519 687.5 L 519 695.5 L 518 696.5 L 518 896 L 497.5 896 Q 496.5 898 492.5 897 L 491.5 896 L 474 896 L 473.5 614 L 457 624.5 L 456.5 798 Q 448.4 743.1 415.5 713 Q 403.97 702.53 388.5 696 L 373.5 692 L 356.5 691 L 355.5 692 L 349.5 692 L 348.5 693 L 340.5 694 L 326.5 700 Q 312.85 707.35 303 718.5 Q 282.75 740.75 274.5 775 L 251 719.5 L 250 714.5 L 237 683.5 L 235 675 L 247.5 673 L 252.5 671 L 256.5 671 L 261.5 669 L 265.5 669 L 289.5 663 L 293.5 661 L 304.5 659 L 370.5 637 L 403.5 623 L 427.5 611 L 474 583 L 473.5 483 Q 448.25 532.75 408.5 568 Q 390.31 584.31 369.5 598 L 323.5 624 L 288.5 639 L 265.5 647 L 244.5 652 L 240.5 654 L 227 656 L 218 639.5 L 245.5 633 L 279.5 622 L 322.5 603 L 347.5 589 L 368.5 575 Q 391.64 558.64 411 538.5 Q 430.8 517.8 446 492.5 L 464 458.5 L 474 434.5 L 474 363 Z"/></svg>`;
const AVATAR_COLORS=["linear-gradient(155deg,#8d80f5,#5b4dd6)","linear-gradient(155deg,#39b2ae,#117a84)","linear-gradient(155deg,#f0b35e,#d98a1f)","linear-gradient(155deg,#5a9cff,#2a6de8)","linear-gradient(155deg,#e46b8a,#b13d6a)","linear-gradient(155deg,#54c08a,#1f8a5a)"];
function avatarFor(email){const s=String(email||"PB"),local=s.replace(/@.*/,""),toks=local.split(/[.\-_+\s]+/).filter(Boolean),letters=((toks.length>=2?toks.slice(0,2).map(x=>x[0]).join(""):local.slice(0,2))||"PB").toUpperCase();let hash=0;for(const ch of s)hash=(hash*31+ch.charCodeAt(0))>>>0;return {txt:letters,bg:AVATAR_COLORS[hash%AVATAR_COLORS.length]}}
const GEAR=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.2 12a7.2 7.2 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.2 7.2 0 0 0-2.1-1.2L14.3 3h-4l-.4 2.7a7.2 7.2 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5a7.3 7.3 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.2 7.2 0 0 0 2.1 1.2l.4 2.7h4l.4-2.7a7.2 7.2 0 0 0 2.1-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z"/></svg>`;
const I={
  arrow:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M9 7h8v8"/></svg>`,
  more:`<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
  trash:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5h6v2M8 7l.8 12.5h6.4L16 7"/></svg>`,
  mac:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.6"/><path d="M2.5 19.5h19"/></svg>`,
  power:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>`,
  theme:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 12c2.5 0 4.5-1.9 4.5-4.25S14.5 3.5 12 3.5"/></svg>`,
  lang:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M9 4v2c0 4-2.2 7-5 8M6 10c.6 2.4 2.6 4.3 5 5M13 20l4-9 4 9M14.5 17h5"/></svg>`,
  cloud:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 1 1 .6-8.97 6 6 0 0 1 11.3 2.17A3.9 3.9 0 0 1 18 18z"/></svg>`,
  plus:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  refresh:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>`,
  server:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>`,
  check:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
  chevDown:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
  chevUp:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>`
};
const ICN={
  warn:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>`
};

function captureScroll(){const el=document.querySelector(".setscroll")||document.querySelector(".acctscroll");return el?{sel:el.classList.contains("setscroll")?".setscroll":".acctscroll",top:el.scrollTop}:null}
function restoreScroll(s){if(!s||!s.top)return;const el=document.querySelector(s.sel);if(el)el.scrollTop=s.top}
function render(){
  const _scroll=captureScroll();
  document.documentElement.lang=lang();
  document.querySelectorAll(".brandMark").forEach((el)=>el.innerHTML=LOGO_BRIDGE);
  document.getElementById("setIco").innerHTML=GEAR;
  document.getElementById("productLabel").textContent=t("products");
  document.getElementById("settingsLabel").textContent=t("settings");
  document.getElementById("railTabs").innerHTML=ui.products.map(p=>tabHtml(p)).join("");
  document.getElementById("settingsTab").setAttribute("aria-current",ui.view==="settings"?"true":"false");
  const aboutTab=document.getElementById("aboutTab");
  if(aboutTab){document.getElementById("aboutIco").innerHTML=window.PandaBridgeAbout.icon;document.getElementById("aboutLabel").textContent=t("aboutAuthor");aboutTab.setAttribute("aria-current",ui.view==="about"?"true":"false")}
  document.getElementById("engine").innerHTML=engineHtml();
  const pane=document.getElementById("pane");
  pane.innerHTML=ui.view==="about"?window.PandaBridgeAbout.html():ui.view==="settings"?settingsHtml():productHtml(productById(ui.selected)||ui.products[0]);
  document.getElementById("modalRoot").innerHTML=modalHtml();
  applyTheme();
  if(ui.view==="about")window.PandaBridgeAbout.init(lang());
  restoreScroll(_scroll);
}
function selectedLive(){
  return ui.status&&ui.status.selected_profile?ui.status.selected_profile:null;
}
function selectedLiveForProfile(p){
  const live=selectedLive();
  if(!live||!p)return null;
  const selectedId=ui.settings&&ui.settings.selected_cloud_profile_id;
  if(p.id===selectedId&&(live.profile_id===p.id||live.api_base===p.api_base))return live;
  return null;
}
function selectedTransportDegraded(){
  const tr=selectedLive()?.transport;
  if(!tr)return !!(ui.status&&ui.status.worker_running&&!ui.status.realtime_connected);
  return tr.polling_active&&tr.realtime_state!=="connected";
}
function engineHtml(){
  if(ui.statusError)return`<span class="e-dot off"></span><span>${t("engineUnavailable")}</span>`;
  if(ui.booting&&!ui.status)return`<span class="e-dot off"></span><span>${t("engineStarting")}</span>`;
  const local=selectedLive()?.local_engine;
  if(local&&local.running===false)return`<span class="e-dot off"></span><span>${t("engineStopped")}</span>`;
  if(local&&local.adapter_health==="missing")return`<span class="e-dot off"></span><span>${t("adapterMissing")}</span>`;
  return selectedTransportDegraded()?`<span class="e-dot off"></span><span>${t("engineReconnect")}</span>`:`<span class="e-dot"></span><span>${t("engineRunning")}</span>`;
}
function productState(p){
  const accts=p.accounts||[];
  if(p.connected)return"live";
  if(p.connection==="reconnecting"||(selectedTransportDegraded()&&accts.some(a=>a.authorized!=="paused")))return"retry";
  return"off";
}
function tabHtml(p){
  const st=productState(p);
  const dot=st==="live"?"live":st==="retry"?"retry":((p.accounts||[]).some(a=>a.authorized==="paused")?"warn":"");
  const style=productStyle(p);
  const icon=productIconHtml(style);
  const tile=icon?`<span class="ptile" style="background:${style.color}">${icon}</span>`:`<span class="ptile" style="background:${style.color}">${esc(p.initials||style.initials)}</span>`;
  return `<button class="pnode" aria-current="${ui.view==="product"&&ui.selected===p.id}" onclick="pick('${p.id}')">
    ${tile}
    <span class="pmeta"><span class="pname">${esc(p.name)}</span></span>
    <i class="sdot ${dot}"></i>
  </button>`;
}
function productHtml(p){
  if(!p)return"";
  const accounts=p.accounts||[];
  if(!accounts.length)return emptyHtml(p);
  const offline=!!(selectedTransportDegraded()&&accounts.some(a=>a.authorized!=="paused"));
  return `<div class="ptop">
      <span class="ptlab">${t("accountsN",{n:accounts.length})}</span>
      <div class="ptend"><button class="btn mini" onclick="openProduct('${p.id}')">${t("open")} ${I.arrow}</button></div>
    </div>
    ${offline?`<div class="netbar"><i class="d"></i>${t("netbar")}</div>`:""}
    <div class="acctscroll">${accounts.map((a,i)=>accountHtml(p,a,i)).join("")}</div>`;
}
function emptyHtml(p){
  const style=productStyle(p);
  const icon=productIconHtml(style);
  const tile=icon?`<span class="elogo" style="background:${style.color}">${icon}</span>`:`<span class="elogo" style="background:${style.color}">${esc(p.initials||style.initials)}</span>`;
  return `<div class="ptop"><span class="ptlab"></span><div class="ptend"><button class="btn mini" onclick="openProduct('${p.id}')">${t("open")} ${I.arrow}</button></div></div>
  <div class="empty">
    ${tile}
    <h2>${t("useOnMac",{name:esc(p.name)})}</h2>
    <div class="esub">${t("emptySub",{name:esc(p.name)})}</div>
    <button class="btn energy" style="padding:9px 22px;font-size:13px;border-radius:11px" onclick="openProduct('${p.id}')">${t("open")} ${esc(p.name)} ${I.arrow}</button>
    <div class="ewait"><i class="d"></i>${t("waiting")}</div>
  </div>`;
}
function accountHtml(p,a,i){
  const active=a.authorized!=="paused";
  const connectionEnabled=a.connection_enabled!==false;
  const connectionOn=active&&connectionEnabled;
  const connected=connectionOn&&!!a.connected;
  const retry=connectionOn&&!connected&&a.connection==="reconnecting";
  const av=avatarFor(a.email);
  let pill;
  if(!active)pill=`<span class="pill paused"><i class="d"></i>${t("pausedTag")}</span>`;
  else if(connected)pill=`<span class="pill live"><i class="d"></i>${t("connected")}</span>`;
  else if(retry)pill=`<span class="pill retry"><i class="d"></i>${t("reconnecting")}</span>`;
  else pill=`<span class="pill idle"><i class="d"></i>${connectionEnabled?t("idle"):t("connectionOff")}</span>`;
  return `<div class="acard ${connected?"live":""}" id="acct-${p.id}-${i}">
    <span class="avatar" style="background:${av.bg}">${esc(av.txt)}</span>
    <div class="awho"><div class="aem">${esc(a.email||"Panda Account")}</div><div class="ameta">${pill}</div></div>
    <div class="actrls"><div class="actrl"><span class="swlabel">${t("conn")}</span><button class="switch" role="switch" aria-checked="${connectionOn}" ${active?"":'disabled aria-disabled="true"'} onclick="toggleConnection('${p.id}',${i})" aria-label="${t("conn")}"></button></div><div class="actrl"><span class="swlabel">${t("auth")}</span><button class="switch" role="switch" aria-checked="${active}" onclick="toggleAuth('${p.id}',${i})" aria-label="${t("auth")}"></button></div></div>
    <button class="amore" title="${t("delete")}" onclick="confirmDelete(event,'${p.id}',${i})">${I.trash}</button>
  </div>`;
}
function settingsHtml(){
  const s=ui.settings;
  const profiles=Array.isArray(s.cloud_profiles)&&s.cloud_profiles.length?s.cloud_profiles:[clone(OFFICIAL_PROFILE)];
  const selected=s.selected_cloud_profile_id||profiles[0]?.id||"official";
  return `<div class="ptop"><span class="ptlab">${t("settings")}</span></div>
  <div class="setscroll">
    ${localComputerHtml()}
    <div class="glab">${t("general")}</div>
    <div class="rows">
      <div><span class="rico n-blue">${I.power}</span><div class="rtext"><div class="t">${t("launch")}</div></div><div class="end"><button class="switch" role="switch" aria-checked="${!!s.launch_at_login}" onclick="setLaunch(${!s.launch_at_login})"></button></div></div>
      <div><span class="rico n-indigo">${I.theme}</span><div class="rtext"><div class="t">${t("appearance")}</div></div><div class="end"><div class="seg">${["auto","light","dark"].map(v=>`<button aria-current="${s.appearance===v}" onclick="setAppearance('${v}')">${t(v==="auto"?"system":v)}</button>`).join("")}</div></div></div>
      <div><span class="rico n-orange">${I.lang}</span><div class="rtext"><div class="t">${t("language")}</div></div><div class="end"><select class="select" onchange="setLanguage(this.value)">${LANG_OPTIONS.map(([code,label])=>`<option value="${code}" ${s.language===code?"selected":""}>${esc(label)}</option>`).join("")}</select></div></div>
    </div>
    <div class="glab glab-cloud"><span>${t("cloudGroup")}</span><div class="cloud-actions"><button class="cbtn cbtn-add" onclick="openServerSheet()" title="${esc(t("addServerTitle"))}">${I.plus}<span>${t("addServer")}</span></button><button class="cbtn cbtn-help" onclick="openSelfhostHelp()" title="${esc(t("selfhostHelp"))}"><span class="help-dot">?</span><span>${t("selfhostHelp")}</span></button></div></div>
    <div class="srvlist">
      ${serverListHtml(profiles,selected)}
    </div>
  </div>`;
}
function localDeviceInfo(){
  const info=ui.status?.local_device||{};
  const fingerprint=String(info.fingerprint||"");
  if(info.identity_source!=="local_install"||!/^PB-[A-Z0-9]{8,24}$/.test(fingerprint))return null;
  return {
    display_name:String(info.display_name||"").slice(0,80)||deviceLabel(),
    model:String(info.model||"").slice(0,80)||platformKind(),
    os:String(info.os||"").slice(0,40)||platformKind(),
    arch:String(info.arch||"").slice(0,40),
    fingerprint,
    identity_source:"local_install"
  };
}
function localComputerHtml(){
  const d=localDeviceInfo();
  if(!d)return `<div class="glab">${t("localComputer")}</div>
    <div class="localcard">
      <span class="rico n-sky">${I.mac}</span>
      <div class="local-main">
        <div class="local-name">${t("localComputerUnavailable")}</div>
        <div class="local-sub">${esc(platformKind())}</div>
      </div>
      <div class="local-fp mono" title="${esc(t("computerFingerprint"))}">--</div>
    </div>`;
  const system=[d.os,d.arch].filter(Boolean).join(" · ");
  return `<div class="glab">${t("localComputer")}</div>
    <div class="localcard">
      <span class="rico n-sky">${I.mac}</span>
      <div class="local-main">
        <div class="local-name">${esc(d.display_name)}</div>
        <div class="local-sub">${esc(d.model)}${system?` · ${esc(system)}`:""}</div>
      </div>
      <div class="local-fp mono" title="${esc(t("computerFingerprint"))}">${esc(d.fingerprint)}</div>
    </div>`;
}
const SERVER_LIST_CAP=4;
function visibleServers(profiles,selected){
  if(profiles.length<=SERVER_LIST_CAP||ui.serverListExpanded)return profiles;
  let visible=profiles.slice(0,SERVER_LIST_CAP);
  if(!visible.some(p=>p.id===selected)){
    const sel=profiles.find(p=>p.id===selected);
    if(sel)visible=profiles.slice(0,SERVER_LIST_CAP-1).concat([sel]);
  }
  return visible;
}
function serverListHtml(profiles,selected){
  const overflow=profiles.length>SERVER_LIST_CAP;
  const expanded=!!ui.serverListExpanded;
  const visible=visibleServers(profiles,selected);
  const cards=visible.map(p=>serverCardHtml(p,selected)).join("");
  const toggle=overflow?`<button class="srv-more" onclick="toggleServerList()">${expanded?`${I.chevUp}<span>${t("collapseServers")}</span>`:`${I.chevDown}<span>${t("expandServers",{n:profiles.length})}</span>`}</button>`:"";
  return `${cards}${toggle}`;
}
function toggleServerList(){ui.serverListExpanded=!ui.serverListExpanded;closePop();render();probeAllServers()}
function serverHealth(p){
  const active=p.id===(ui.settings.selected_cloud_profile_id);
  const live=active?selectedLiveForProfile(p):null;
  const probed=serverHealthState(p.id);
  const persistedError=profileProbeError(p);
  if(probed&&probed.state==="checking"&&(serverBusy(p.id)||!live))return{state:"checking",latency:probed.latency};
  if(probed&&probed.state==="offline")return{state:"offline",latency:probed.latency};
  if(active){
    if(ui.statusError)return{state:"offline"};
    if(live){
      const s=live.server||{};
      const nativeLatency=s.probe_latency_ms||null;
      if(s.source==="profile_probe_stale")return{state:"checking"};
      if(s.reachable===false||s.error)return{state:"offline"};
      if(s.compatible===false)return{state:"degraded"};
      if(s.reachable===true&&s.compatible===true)return{state:"online",latency:nativeLatency};
      if(s.reachable===true)return{state:"unknown",latency:nativeLatency};
    }
  }
  if(!live&&persistedError)return{state:"offline"};
  if(probed&&probed.state)return{state:probed.state,latency:probed.latency};
  return{state:"unknown"};
}
function serverDetail(p,h){
  const live=selectedLiveForProfile(p);
  const probeState=serverHealthState(p.id);
  if(h.state==="offline"&&probeState?.error)return String(probeState.error).slice(0,120);
  if(!live){
    const persistedError=profileProbeError(p);
    if(persistedError)return persistedError;
    return p.api_base||"";
  }
  if(p.id===ui.settings.selected_cloud_profile_id&&live.server?.error&&h.state==="offline"){
    return [String(live.server.error).slice(0,120),serverProbeDetail(live.server)].filter(Boolean).join(" · ");
  }
  const device=live.device?.paired?(live.device.present===true?t("devicePresent"):t("devicePaired")):t("deviceUnpaired");
  const auth=live.account?.authorized?t("authActive"):t("authNone");
  const local=live.local_engine?.running===false?t("engineStopped"):(live.local_engine?.adapter_health==="missing"?t("adapterMissing"):t("engineReady"));
  const tr=live.transport?.realtime_state==="connected"?t("transportRealtime"):(live.transport?.polling_state==="active"?t("transportPolling"):t("transportIdle"));
  return [device,auth,local,tr,serverProbeDetail(live.server)].filter(Boolean).join(" · ");
}
function serverProbeDetail(s){if(!s)return"";const p=[],ph=probePhaseLabel(s.failure_phase);if(s.failure_phase)p.push(`${t("probeFailedAt")} ${ph}`);if(s.health_latency_ms)p.push(`${t("probeHealth")} ${Math.round(s.health_latency_ms)}ms`);if(s.diagnostics_latency_ms)p.push(`${t("probeDiagnostics")} ${Math.round(s.diagnostics_latency_ms)}ms`);return p.join(" · ")}
function probePhaseLabel(phase){const p=String(phase||"").toLowerCase();return p==="health"?t("probeHealth"):p==="diagnostics"?t("probeDiagnostics"):(p||"probe")}
function serverCardHtml(p,selectedId){
  const active=p.id===selectedId;
  const official=p.id==="official";
  const host=hostOnly(p.api_base);
  const h=serverHealth(p);
  const busy=serverBusy(p.id);
  const cooling=serverProbeCooldownMs(p.id)>0;
  const lat=h.state==="online"&&h.latency?` <span class="srv-lat">· ${h.latency}ms</span>`:"";
  const label=h.state==="degraded"&&selectedLiveForProfile(p)?.server?.compatible===false?t("healthIncompatible"):t("health"+h.state.charAt(0).toUpperCase()+h.state.slice(1));
  const detail=serverDetail(p,h);
  const ico=official
    ?`<span class="srv-ico n-cyan">${I.cloud}</span>`
    :`<span class="srv-ico n-gray">${I.server}</span>`;
  const actions=`<div class="srv-actions">
      <button class="srv-act${h.state==="checking"?" spin":""}" title="${esc(t("recheck"))}" aria-label="${esc(t("recheck"))}" onclick="probeServer(event,'${esc(p.id)}')" ${busy||cooling?`disabled${busy?" aria-busy=\"true\"":""}`:""}>${I.refresh}</button>
      ${official?"":`<button class="srv-act danger" title="${esc(t("delete"))}" aria-label="${esc(t("delete"))}" onclick="confirmRemoveServer(event,'${esc(p.id)}')">${I.trash}</button>`}
    </div>`;
  return `<div class="srv ${active?"active":""}" data-pid="${esc(p.id)}" role="button" tabindex="0" aria-current="${active}" aria-busy="${busy?"true":"false"}" onclick="selectServer(event,'${esc(p.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectServer(event,'${esc(p.id)}')}">
      ${ico}
      <div class="srv-meta">
        <div class="srv-name"><span class="nm">${esc(p.name||host)}</span>${active?`<span class="srv-cur">${t("currentTag")}</span>`:`<span class="srv-cur" style="background:var(--surface-2);color:var(--ink-3)">${official?t("officialTag"):t("selfhostTag")}</span>`}</div>
        <div class="srv-host mono">${esc(host)}</div>
        <div class="srv-detail">${esc(detail)}</div>
      </div>
      <span class="srv-health ${h.state}"><i class="d"></i>${label}${lat}</span>
      ${actions}
    </div>`;
}
function patchServerCard(id){
  const card=[...document.querySelectorAll(".srv")].find(el=>el.dataset.pid===id);
  if(!card)return false;
  const profiles=(ui.settings&&ui.settings.cloud_profiles)||[];
  const p=profiles.find(x=>x.id===id);
  if(!p)return false;
  const h=serverHealth(p);
  const busy=serverBusy(id);
  const cooling=serverProbeCooldownMs(id)>0;
  const lat=h.state==="online"&&h.latency?` <span class="srv-lat">· ${h.latency}ms</span>`:"";
  const label=h.state==="degraded"&&selectedLiveForProfile(p)?.server?.compatible===false?t("healthIncompatible"):t("health"+h.state.charAt(0).toUpperCase()+h.state.slice(1));
  const detail=serverDetail(p,h);
  const badge=card.querySelector(".srv-health");
  if(badge){
    const sig=h.state+"|"+label+"|"+(h.state==="online"&&h.latency?h.latency:"");
    if(badge.dataset.sig!==sig){
      const animate=badge.dataset.sig!==undefined&&badge.dataset.sig!=="";
      badge.className="srv-health "+h.state;badge.innerHTML=`<i class="d"></i>${label}${lat}`;badge.dataset.sig=sig;
      if(animate){badge.classList.add("bumped");clearTimeout(badge.__bumpT);badge.__bumpT=setTimeout(()=>badge.classList.remove("bumped"),520)}
    }
  }
  const detailEl=card.querySelector(".srv-detail");
  if(detailEl&&detailEl.textContent!==detail)detailEl.textContent=detail;
  card.setAttribute("aria-busy",busy?"true":"false");
  const refreshBtn=card.querySelector(".srv-act:not(.danger)");
  if(refreshBtn){
    refreshBtn.classList.toggle("spin",h.state==="checking");
    if(busy||cooling){refreshBtn.disabled=true;if(busy)refreshBtn.setAttribute("aria-busy","true");else refreshBtn.removeAttribute("aria-busy")}
    else{refreshBtn.disabled=false;refreshBtn.removeAttribute("aria-busy")}
  }
  return true;
}
function serverSheetHtml(){
  const f=ui.serverSheet||{};
  return `<div class="sheetwrap on" id="sheetwrap" onclick="if(event.target===this)closeServerSheet()"><div class="sheet"><div class="sh-glow"></div>
    <div class="sh-top">
      <div class="sh-mini"><span class="plus">${I.server}</span></div>
      <h3>${t("addServerTitle")}</h3>
      <div class="acctline">${t("addServerDesc")}</div>
    </div>
    <div class="sh-form">
      <div class="sh-field">
        <label for="cloudApiInput">${t("serverUrlLabel")}</label>
        <input id="cloudApiInput" class="input" placeholder="${esc(t("serverUrl"))}" spellcheck="false" autocapitalize="off" autocomplete="off" value="${esc(f.api||"")}" oninput="ui.serverSheet.api=this.value;syncPairSubmit()">
      </div>
      <div class="sh-field">
        <label for="pairTokenInput">${t("pairingToken")}</label>
        <input id="pairTokenInput" class="input mono" placeholder="${esc(t("pairingToken"))}" autocomplete="one-time-code" spellcheck="false" value="${esc(f.token||"")}" oninput="ui.serverSheet.token=this.value;syncPairSubmit()" onkeydown="if(event.key==='Enter')submitPairServer()">
        <div class="hint">${t("pairTokenHint")}</div>
      </div>
      ${f.error?`<div class="sh-formerr">${ICN.warn}<span>${esc(f.error)}</span></div>`:""}
    </div>
    <div class="sh-foot">
      <button class="btn" onclick="closeServerSheet()" ${f.busy?"disabled":""}>${t("cancel")}</button>
      <button class="btn energy" id="pairSubmit" onclick="submitPairServer()" ${f.busy||!((f.api||"").trim()&&(f.token||"").trim())?"disabled":""}>${f.busy?t("pairingBusy"):t("pairServer")}</button>
    </div>
  </div></div>`;
}
function modalHtml(){
  if(!ui.pending)return ui.serverSheet?serverSheetHtml():`<div class="sheetwrap" id="sheetwrap"></div>`;
  if(ui.pending.error)return `<div class="sheetwrap on" id="sheetwrap"><div class="sheet haz"><div class="sh-glow"></div>
    <div class="sh-top"><h3>${esc(ui.pending.product_name)}</h3><div class="org">${esc(ui.pending.domain)}</div></div>
    <div class="dgr warn"><div class="dgr-h">${ICN.warn}<span>${t("failed")}</span></div><div class="dperr">${esc(ui.pending.error)}</div></div>
    <div class="sh-foot"><button class="btn" onclick="denyIntent()">${t("cancel")}</button></div>
  </div></div>`;
  const pendingStyle=productStyle(ui.pending);
  const pendingIcon=productIconHtml(pendingStyle)||esc((ui.pending.product_name||"PB").slice(0,2).toUpperCase());
  const confirming=!!ui.pending.confirming;
  const allowBody=confirming?`<span class="spinmark" aria-hidden="true"></span><span>${t("authorizing")}</span>`:t("allow");
  return `<div class="sheetwrap on" id="sheetwrap"><div class="sheet ${confirming?"processing":""}"><div class="sh-glow"></div>
    <div class="sh-top">
      <div class="sh-mini">
        <span class="t" style="background:${pendingStyle.color}">${pendingIcon}</span>
        <span class="conn"><i></i><i></i><i></i></span>
        <span class="mac">${I.mac}</span>
      </div>
      <h3>${t("wants",{name:esc(ui.pending.product_name)})}</h3>
      <div class="org">${esc(ui.pending.domain)}</div>
      <div class="acctline">${esc(ui.pending.account)}</div>
    </div>
    ${authSummaryHtml(ui.pending)}
    <div class="sh-foot"><button class="btn" onclick="denyIntent()" ${confirming?"disabled":""}>${t("deny")}</button><button class="btn energy ${confirming?"busy":""}" id="allowIntentButton" onclick="allowIntent()" ${confirming?"disabled aria-busy=\"true\"":""}>${allowBody}</button></div>
  </div></div>`;
}
function authSummaryHtml(p){
  const pa=p.product_authorization||{};
  const caps=(p.policy_caps||[]).join(", ")||"none";
  const control=pa.control||pa.mode||pa.enforcement||"product-controlled";
  return `<div class="authsum" aria-label="relay policy summary">
    <div class="authsum-row"><span class="authsum-k">source_origin</span><span class="authsum-v">${esc(p.source_origin||p.domain||"unknown")}</span></div>
    <div class="authsum-row"><span class="authsum-k">policy caps</span><span class="authsum-v">${esc(caps)}</span></div>
    <div class="authsum-row"><span class="authsum-k">product_authorization</span><span class="authsum-v">${esc(pa.owner||"none")} · ${esc(control)}</span></div>
  </div>`;
}
function productById(id){return ui.products.find(p=>p.id===id)}
function displayHost(p){return p.origin||p.domain||hostOnly(p.web_url)}
function hostOnly(value){try{return new URL(value).host}catch{return String(value||"").replace(/^https?:\/\//,"").replace(/\/.*$/,"")}}
function pick(id){ui.view="product";ui.selected=id;closePop();stopServerAutoRefresh();render()}
function pickSettings(){ui.view="settings";closePop();render();probeAllServers();startServerAutoRefresh()}
function pickAbout(){ui.view="about";closePop();stopServerAutoRefresh();render()}
async function toggleAuth(productId,index){
  const p=productById(productId),a=p?.accounts?.[index];if(!a)return;
  try{await window.PandaBridge.call("toggle_authorization",{product_id:productId,account:a.id||a.email});toast(a.authorized==="paused"?t("resumed"):t("paused"));await refresh()}catch(e){showError(e)}
}
async function toggleConnection(productId,index){const p=productById(productId),a=p?.accounts?.[index];if(!a||a.authorized==="paused")return;const next=a.connection_enabled===false;try{await window.PandaBridge.call("toggle_connection",{product_id:productId,account:a.id||a.email,enabled:next});toast(next?t("connectionResumed"):t("connectionPaused"));await refresh()}catch(e){showError(e)}}
async function removeAccount(productId,index){
  const p=productById(productId),a=p?.accounts?.[index];if(!a)return;
  const row=document.getElementById(`acct-${productId}-${index}`);if(row)row.classList.add("leaving");
  closePop();
  try{await window.PandaBridge.call("remove_authorization",{product_id:productId,account_id:a.id||a.email,account:a.id||a.email});toast(t("removed"));await refresh()}catch(e){showError(e);await refresh()}
}
async function openProduct(productId){try{await window.PandaBridge.call("open_web",{product_id:productId});toast(t("opened"))}catch(e){showError(e)}}
async function setLaunch(value){ui.settings.launch_at_login=value;render();await saveSettings({launch_at_login:value})}
async function setAppearance(value){ui.settings.appearance=value;render();await saveSettings({appearance:value})}
async function setLanguage(value){ui.settings.language=value;render();await saveSettings({language:value})}
async function saveSettings(patch){try{ui.settings=await window.PandaBridge.call("update_settings",patch);render()}catch(e){showError(e)}}
async function selectCloudProfile(id){
  try{ui.settings=await window.PandaBridge.call("select_cloud_profile",{profile_id:id});toast(t("serverSelected"));await refresh()}catch(e){showError(e);await refresh().catch(()=>{})}
}
async function addCloudProfile(){
  const input=document.getElementById("cloudApiInput");const api=(input?.value||"").trim();if(!api)return;
  try{ui.settings=await window.PandaBridge.call("add_cloud_profile",{api});toast(t("serverAdded"));await refresh()}catch(e){showError(e)}
}
function openSelfhostHelp(){if(SELFHOST_HELP_URL)window.PandaBridge.call("open_web",{url:SELFHOST_HELP_URL}).catch(()=>{})}
function openServerSheet(){ui.serverSheet={api:"",token:"",busy:false,error:""};render();setTimeout(()=>{const el=document.getElementById("cloudApiInput");if(el)el.focus()},60)}
function closeServerSheet(){if(ui.serverSheet&&ui.serverSheet.busy)return;if(!ui.serverSheet)return;ui.serverSheet=null;render()}
function syncPairSubmit(){const f=ui.serverSheet;if(!f)return;const btn=document.getElementById("pairSubmit");if(btn)btn.disabled=!!f.busy||!((f.api||"").trim()&&(f.token||"").trim())}
async function submitPairServer(){
  const f=ui.serverSheet;if(!f)return;
  const api=(f.api||"").trim();const token=(f.token||"").trim();if(!api||!token)return;
  f.busy=true;f.error="";render();
  try{
    ui.settings=await window.PandaBridge.call("pair_selfhost_profile",{api,token,name:"My Server"});
    const id=ui.settings.selected_cloud_profile_id;if(id)ui.health[id]={state:"checking",at:Date.now()};
    ui.serverSheet=null;toast(t("serverAdded"));await refresh();
  }catch(e){if(ui.serverSheet){ui.serverSheet.busy=false;ui.serverSheet.error=String(e?.message||e).slice(0,200)}render()}
}
async function selectServer(ev,id){
  if(ev&&ev.target&&ev.target.closest&&ev.target.closest(".srv-act"))return;
  if(id===(ui.settings&&ui.settings.selected_cloud_profile_id))return;
  if(serverBusy(id))return;
  const token=beginServerProbe(id,"select");let switched=false;render();
  try{const settings=await window.PandaBridge.call("select_cloud_profile",{profile_id:id});if(!serverProbeCurrent(id,token))return;ui.settings=settings;ui.health[id]={state:"checking",at:Date.now()};toast(t("serverSelected"));switched=true}catch(e){if(serverProbeCurrent(id,token)){ui.health[id]={state:"offline",error:String(e?.message||e),at:Date.now()};showError(e)}}
  finally{const current=serverProbeCurrent(id,token);finishServerProbe(id,token);render();if(current&&switched){await refresh().catch(()=>{});setServerProbeBackoff(id,0);probeServer(null,id)}else if(current)refresh().catch(()=>{})}
}
async function probeServer(ev,id,opts){
  const silent=!!(opts&&opts.silent);
  if(ev&&ev.stopPropagation)ev.stopPropagation();
  if(serverBusy(id)||serverProbeCooldownMs(id)>0)return;
  const token=beginServerProbe(id,"probe",silent);let shouldRefresh=false;
  if(!silent){if(!patchServerCard(id))render()}
  try{
    const settings=await window.PandaBridge.call("refresh_cloud_profile",{profile_id:id});if(!serverProbeCurrent(id,token))return;ui.settings=settings;
    const profile=((ui.settings&&ui.settings.cloud_profiles)||[]).find(p=>p.id===id);
    const persistedError=profileProbeError(profile);
    if(persistedError){ui.health[id]={state:"offline",error:persistedError,at:Date.now()};setServerProbeBackoff(id,SERVER_PROBE_FAILURE_BACKOFF_MS);shouldRefresh=true;return}
    const latency=profileProbeLatency(profile);
    ui.health[id]={state:"online",latency,at:Date.now()};setServerProbeBackoff(id,SERVER_PROBE_SUCCESS_COOLDOWN_MS);shouldRefresh=true;return;
  }catch(e){if(serverProbeCurrent(id,token)){ui.health[id]={state:"offline",error:String(e?.message||e),at:Date.now()};setServerProbeBackoff(id,SERVER_PROBE_FAILURE_BACKOFF_MS);shouldRefresh=true}}
  finally{const current=serverProbeCurrent(id,token);finishServerProbe(id,token);if(!patchServerCard(id))render();if(current&&shouldRefresh&&id===(ui.settings&&ui.settings.selected_cloud_profile_id))refresh().catch(()=>{})}
}
function serverBusy(id){return !!(ui.serverBusy&&ui.serverBusy[id])}
function setServerBusy(id,value){ui.serverBusy=ui.serverBusy||{};if(value)ui.serverBusy[id]=value;else delete ui.serverBusy[id]}
function serverProbeTimeoutMs(){const n=Number(window.__PANDA_BRIDGE_TEST_PROBE_TIMEOUT_MS||SERVER_PROBE_UI_TIMEOUT_MS);return Number.isFinite(n)&&n>0?n:SERVER_PROBE_UI_TIMEOUT_MS}
function serverHealthState(id){const h=ui.health&&ui.health[id];return h&&h.state==="checking"&&Date.now()-Number(h.at||0)>serverProbeTimeoutMs()?{state:"offline",error:t("serverProbeTimedOut"),at:h.at,timedOut:true}:h}
function beginServerProbe(id,kind,silent){const token=`${Date.now()}-${Math.random()}`;ui.serverProbeTokens[id]=token;setServerBusy(id,kind||"probe");if(!silent||!ui.health[id])ui.health[id]={state:"checking",at:Date.now()};if(ui.serverProbeTimers[id])clearTimeout(ui.serverProbeTimers[id]);ui.serverProbeTimers[id]=setTimeout(()=>expireServerProbe(id,token),serverProbeTimeoutMs());return token}
function serverProbeCurrent(id,token){return !!token&&ui.serverProbeTokens&&ui.serverProbeTokens[id]===token}
function finishServerProbe(id,token){if(token&&!serverProbeCurrent(id,token))return;if(ui.serverProbeTimers&&ui.serverProbeTimers[id]){clearTimeout(ui.serverProbeTimers[id]);delete ui.serverProbeTimers[id]}if(ui.serverProbeTokens)delete ui.serverProbeTokens[id];setServerBusy(id,null)}
function expireServerProbe(id,token){if(token&&!serverProbeCurrent(id,token))return;ui.health[id]={state:"offline",error:t("serverProbeTimedOut"),at:Date.now(),timedOut:true};finishServerProbe(id,token);if(!patchServerCard(id))render()}
function setServerProbeBackoff(id,ms){ui.serverProbeBackoff=ui.serverProbeBackoff||{};ui.serverProbeBackoffTimers=ui.serverProbeBackoffTimers||{};if(ui.serverProbeBackoffTimers[id]){clearTimeout(ui.serverProbeBackoffTimers[id]);delete ui.serverProbeBackoffTimers[id]}if(ms>0){ui.serverProbeBackoff[id]=Date.now()+ms;ui.serverProbeBackoffTimers[id]=setTimeout(()=>{delete ui.serverProbeBackoffTimers[id];if(serverProbeCooldownMs(id)<=0)render()},ms+20)}else delete ui.serverProbeBackoff[id]}
function serverProbeCooldownMs(id){const until=Number(ui.serverProbeBackoff&&ui.serverProbeBackoff[id]||0),left=until-Date.now();if(left<=0){if(until)setServerProbeBackoff(id,0);return 0}return left}
function profileProbeLatency(profile){
  const updated=String(profile?.updated_at||"");
  if(!updated.startsWith("probe:"))return null;
  const value=profileProbeMarkerNumber(updated,"latency_ms")||profileProbeMarkerNumber(updated,"total_ms")||0;
  return Number.isFinite(value)&&value>0?Math.round(value):null;
}
function profileProbeMarkerNumber(updated,key){const part=String(updated||"").split("|").slice(1).find(item=>item.trim().startsWith(`${key}:`)),value=part?Number(part.split(":").slice(1).join(":").trim()):0;return Number.isFinite(value)&&value>0?value:null}
function profileProbeError(profile){
  const updated=String(profile?.updated_at||"");
  if(!updated.startsWith("probe_error:"))return null;
  const at=updated.indexOf("|");
  if(at<0)return null;
  const detail=updated.slice(at+1).split("|").map(part=>part.trim()).filter(part=>part&&!/^(phase|latency_ms|total_ms|health_ms|diagnostics_ms):/i.test(part)).join(" ").replace(/[\r\n|]+/g," ").replace(/\s+/g," ").trim();
  return detail?detail.slice(0,120):null;
}
const SERVER_HEALTH_TTL_MS=15000;
function probeAllServers(opts){
  if(ui.serverSheet||ui.view!=="settings")return;
  const silent=!!(opts&&opts.silent);
  const force=!!(opts&&opts.force);
  const profiles=(ui.settings&&ui.settings.cloud_profiles)||[];
  const selected=(ui.settings&&ui.settings.selected_cloud_profile_id)||"";
  visibleServers(profiles,selected).forEach((p,i)=>{
    if(serverBusy(p.id))return;// a probe is genuinely in flight
    if(serverProbeCooldownMs(p.id)>0)return;// just probed — don't hammer
    const cur=ui.health[p.id];
    const fresh=!force&&cur&&(cur.state==="online"||cur.state==="offline")&&(Date.now()-Number(cur.at||0))<SERVER_HEALTH_TTL_MS;
    if(fresh)return;
    setTimeout(()=>{if(!ui.serverSheet&&ui.view==="settings"&&!serverBusy(p.id)&&serverProbeCooldownMs(p.id)<=0)probeServer(null,p.id,{silent})},130*i);
  });
}
let serverAutoRefreshTimer=null;
function startServerAutoRefresh(){
  stopServerAutoRefresh();
  serverAutoRefreshTimer=setInterval(()=>{
    if(ui.view!=="settings"||ui.serverSheet){stopServerAutoRefresh();return}
    if(typeof document!=="undefined"&&document.hidden)return;
    probeAllServers({silent:true});
  },SERVER_HEALTH_TTL_MS);
}
function stopServerAutoRefresh(){if(serverAutoRefreshTimer){clearInterval(serverAutoRefreshTimer);serverAutoRefreshTimer=null}}
let focusRefreshTimer=null;
function onWindowFocus(){if(ui.view!=="settings"||ui.serverSheet)return;clearTimeout(focusRefreshTimer);focusRefreshTimer=setTimeout(()=>{if(ui.view==="settings"&&!ui.serverSheet)probeAllServers({silent:true,force:true})},220)}
function confirmRemoveServer(ev,id){
  ev.stopPropagation();
  const p=((ui.settings&&ui.settings.cloud_profiles)||[]).find(x=>x.id===id);if(!p)return;
  closePop();popEl=document.createElement("div");popEl.className="pop";
  popEl.innerHTML=`<div class="cf-t">${t("removeServerConfirm",{name:esc(p.name||hostOnly(p.api_base))})}</div><div class="cf-d">${t("removeServerDesc")}</div><div class="cf-row"><button class="btn" onclick="closePop()">${t("cancel")}</button><button class="btn dangerfill" onclick="doRemoveServer('${esc(id)}')">${t("delete")}</button></div>`;
  document.body.appendChild(popEl);
  const r=ev.currentTarget.getBoundingClientRect(),pw=popEl.offsetWidth,ph=popEl.offsetHeight;
  let x=Math.min(r.right-pw+4,innerWidth-pw-8),y=r.bottom+6;if(y+ph>innerHeight-8)y=r.top-ph-6;
  popEl.style.left=Math.max(8,x)+"px";popEl.style.top=y+"px";
}
function doRemoveServer(id){closePop();delete ui.health[id];removeCloudProfile(id)}
async function refreshCloudProfile(id){
  try{ui.settings=await window.PandaBridge.call("refresh_cloud_profile",{profile_id:id});toast(t("serverRefreshed"));await refresh()}catch(e){showError(e)}
}
async function removeCloudProfile(id){
  try{ui.settings=await window.PandaBridge.call("remove_cloud_profile",{profile_id:id});toast(t("serverRemoved"));await refresh()}catch(e){showError(e)}
}
async function refresh(){
  const status=await window.PandaBridge.call("status");
  ui.booting=false;ui.statusError=null;
  ui.status=status;ui.settings={...ui.settings,...(status.settings||{})};
  ui.products=normalizeProducts(status.products||[]);
  if(!productById(ui.selected))ui.selected=ui.products[0]?.id||"panda-burn";
  render();return status;
}
function normalizeProducts(items){
  const source=Array.isArray(items)&&items.length?items:BASE_PRODUCTS;
  return source.map((src,index)=>{
    const base=BASE_PRODUCTS.find(p=>p.id===src.id)||{};
    const style=productStyle(src,index);
    const accounts=Array.isArray(src.accounts)?src.accounts.map(a=>({
      id:a.id||null,email:a.email||"Panda Account",authorized:a.authorized||"active",connection_enabled:a.connection_enabled!==false,connected:!!a.connected,connection:a.connection||"reconnecting"
    })):[];
    return {...clone(base),...src,origin:src.origin||base.origin||hostOnly(src.web_url),web_url:src.web_url||base.web_url||src.origin||"",initials:style.initials,color:style.color,icon:style.icon,accounts,connected:!!src.connected,connection:src.connection||"offline"};
  });
}
let svgIconSeq=0;
function productIconHtml(style){
  if(!style?.icon)return"";
  const suffix=`_${++svgIconSeq}`;
  return String(style.icon)
    .replace(/\b(burnGradient|emberGradient|softLift|tokenParticles|title|desc)\b/g,`$1${suffix}`)
    .replace("<svg ","<svg aria-hidden=\"true\" focusable=\"false\" ");
}
function productStyle(p,index=0){
  const productId=p?.id||p?.product_id;
  const base=BASE_PRODUCTS.find(x=>x.id===productId);
  if(base)return {initials:base.initials,color:base.color,icon:base.icon||null};
  const name=String(p?.name||p?.product_name||productId||"PB").trim();
  const initials=name.split(/[\s_-]+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase()||name.slice(0,2).toUpperCase()||"PB";
  const colors=["linear-gradient(150deg,#2f7bff,#14a6a6)","linear-gradient(150deg,#4d8dff,#7857d9)","linear-gradient(150deg,#1f9d67,#2374d9)","linear-gradient(150deg,#e46b4c,#7b61ff)"];
  let hash=index;for(const ch of String(productId||name))hash=(hash*31+ch.charCodeAt(0))>>>0;
  return {initials,color:colors[hash%colors.length],icon:p?.icon||null};
}
async function handleDeepLink(raw){
  const url=new URL(raw);const intent=url.searchParams.get("intent");if(!intent)return;
  const api=url.searchParams.get("api")||DEFAULT_API;
  const pre=await window.PandaBridge.call("preview_intent",{api,intent});
  const policy=pre.local_policy||{};
  const displayName=(policy.display&&policy.display.product)||pre.product_name;
  const known=knownFrom(pre.product_id,displayName,pre.cloud_origin);
  ui.pending={api,intent,product_id:pre.product_id,product_name:displayName||known.name,domain:known.origin,source_origin:policy.source_origin||pre.cloud_origin,policy_caps:pre.capabilities||policy.capabilities||[],product_authorization:policy.product_authorization||{},account:pre.user_display_name||"Panda Account",account_id:pre.user_id||null,select:known.id};
  render();
}
function showDeepLinkError(raw,error){
  let domain="panda-bridge://connect";
  try{const u=new URL(raw);domain=u.searchParams.get("api")||u.protocol}catch{}
  ui.pending={product_name:"Bridge authorization",domain,error:String(error?.message||error).slice(0,240)};
  render();
  showError(error);
}
function knownFrom(id,name,origin){
  const norm=normalizeProductKey(id);
  const existing=ui.products.find(p=>normalizeProductKey(p.id)===norm||normalizeProductKey(p.name)===norm);
  if(existing)return existing;
  const dynamic={id:id||normalizeProductKey(name)||"custom",name:name||id||"Custom Product",origin:origin||hostOnly(DEFAULT_API),web_url:origin||""};
  return {...dynamic,...productStyle(dynamic)};
}
function normalizeProductKey(value){return String(value||"").replace(/[^a-z0-9]/gi,"").toLowerCase()}
function denyIntent(){ui.pending=null;render()}
async function allowIntent(){
  const p=ui.pending;if(!p)return;
  if(p.confirming)return;
  ui.pending={...p,confirming:true};
  render();
  try{
    const pending=await window.PandaBridge.call("claim_intent_preview",{api:p.api,intent:p.intent,device_name:localDeviceInfo()?.display_name||`Panda Bridge ${navigator.platform||"Desktop"}`});
    await window.PandaBridge.call("confirm_pending_intent",{pending_id:pending.pending_id,intent:p.intent});
    ui.pending=null;ui.selected=p.select;ui.view="product";render();await window.PandaBridge.call("start_worker");await refresh()
  }catch(e){
    if(ui.pending&&ui.pending.intent===p.intent)ui.pending={...p,confirming:false};
    render();
    showError(e)
  }
}
let popEl=null;
function closePop(){if(popEl){popEl.remove();popEl=null}}
function confirmDelete(ev,productId,index){
  ev.stopPropagation();const p=productById(productId),a=p?.accounts?.[index];if(!a)return;
  closePop();popEl=document.createElement("div");popEl.className="pop";
  const short=String(a.email||"").split("@")[0]||a.email;
  popEl.innerHTML=`<div class="cf-t">${t("confirmDelete",{name:esc(short)})}</div><div class="cf-d">${t("deleteDesc")}</div><div class="cf-row"><button class="btn" onclick="closePop()">${t("cancel")}</button><button class="btn dangerfill" onclick="removeAccount('${productId}',${index})">${t("delete")}</button></div>`;
  document.body.appendChild(popEl);
  const r=ev.currentTarget.getBoundingClientRect(),pw=popEl.offsetWidth,ph=popEl.offsetHeight;
  let x=Math.min(r.right-pw+4,innerWidth-pw-8),y=r.bottom+6;if(y+ph>innerHeight-8)y=r.top-ph-6;
  popEl.style.left=Math.max(8,x)+"px";popEl.style.top=y+"px";
}
document.addEventListener("pointerdown",e=>{if(popEl&&!popEl.contains(e.target))closePop()},true);
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closePop();closeServerSheet();denyIntent()}});
window.addEventListener("focus",onWindowFocus);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)onWindowFocus()});
let toastTimer;
function toast(msg){document.getElementById("toastTxt").textContent=msg;const el=document.getElementById("toast");el.classList.add("on");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("on"),1900)}
function showError(e){toast(`${t("failed")} · ${String(e?.message||e).slice(0,120)}`)}
function installFallback(){
  const params=new URLSearchParams(location.search);
  const emptyDemo=params.get("empty");
  const slowConfirm=params.get("slowConfirm")==="1";
  const officialError=params.get("officialError")==="1";
  const demoAccountLabel="Burn Demo Identity";
  const teamAccountLabel="Team Demo Identity";
  const mock={settings:{launch_at_login:true,appearance:new URLSearchParams(location.search).get("theme")||"auto",language:"auto",api_base:DEFAULT_API,cloud_profiles:[clone(OFFICIAL_PROFILE)],selected_cloud_profile_id:"official"},products:normalizeProducts([
    {id:"panda-burn",name:"Burn",origin:"https://token-burn.com",web_url:"https://token-burn.com/authorize",accounts:emptyDemo?[]:[{id:"demo_burn",email:demoAccountLabel,authorized:"active",connection_enabled:true,connected:true,connection:"connected"}],connected:!emptyDemo,connection:emptyDemo?"offline":"connected"}
  ])};
  function mockStatus(){
    const profile=mock.settings.cloud_profiles.find(p=>p.id===mock.settings.selected_cloud_profile_id)||mock.settings.cloud_profiles[0]||OFFICIAL_PROFILE;
    const accounts=mock.products.flatMap(p=>p.accounts||[]);
    const authorized=accounts.some(a=>a.authorized!=="paused");
    const connectionEnabled=accounts.some(a=>a.authorized!=="paused"&&a.connection_enabled!==false);
    mock.products.forEach(p=>{const on=(p.accounts||[]).some(a=>a.authorized!=="paused"&&a.connection_enabled!==false&&a.connected);p.connected=on;p.connection=on?"connected":((p.accounts||[]).some(a=>a.authorized!=="paused"&&a.connection_enabled!==false)?"reconnecting":"offline")});
    const paired=profile.id!=="official"||authorized;
    const serverReachable=profile.id==="official"?null:true;
    const serverCompatible=profile.id==="official"?null:true;
    const serverError=profile.id==="official"&&officialError?"Official server probe failed":null;
    const server={reachable:serverReachable,compatible:serverCompatible,last_probe_at:serverReachable?new Date().toISOString():null,error:serverError,source:serverReachable?"demo_profile_probe":"demo_not_probed"};
    if(serverReachable){server.probe_latency_ms=12;server.health_latency_ms=4;server.diagnostics_latency_ms=8}
    const running=connectionEnabled;
    return {
      ...clone(mock),
      local_device:{
        display_name:"Smoke Local Computer",
        model:platformKind()==="mac"?"Mac":"Desktop",
        os:platformKind()==="windows"?"windows":platformKind()==="mac"?"macos":"linux",
        arch:"x64",
        fingerprint:"PB-0123ABCD4567",
        identity_source:"local_install"
      },
      worker_running: running,
      realtime_connected: connectionEnabled,
      selected_profile:{
        profile_id:profile.id,
        label:profile.name||hostOnly(profile.api_base),
        api_base:profile.api_base,
        server,
        device:{paired,present:connectionEnabled?true:(paired?null:false),last_seen_at:connectionEnabled?new Date().toISOString():null,device_id:paired?"mock_device":null,device_name:paired?deviceLabel():null},
        account:{authorized,authorization_state:authorized?"active":"none",connection_enabled:connectionEnabled,account_id:authorized?"demo_burn":null,account_display:authorized?demoAccountLabel:null,product_ids:connectionEnabled?["panda-burn"]:[]},
        local_engine:{running,adapter_health:connectionEnabled?"configured":"idle",adapter_configured:connectionEnabled,adapter_running:false,adapter_products:connectionEnabled?[{product_id:"panda-burn",state:"configured",configured:true,running:false,endpoint_source:"mock"}]:[]},
        transport:{realtime_state:connectionEnabled?"connected":"idle",polling_state:connectionEnabled?"active":"idle",realtime_connected:connectionEnabled,polling_active:connectionEnabled,degraded_reason:null}
      }
    };
  }
  window.ipc={postMessage(raw){const req=JSON.parse(raw);const reply=(ok,result,error,delay=50)=>setTimeout(()=>window.PandaBridge.receive({type:"response",id:req.id,ok,result,error}),delay);
    if(req.command==="status")return reply(true,mockStatus());
    if(req.command==="settings")return reply(true,clone(mock.settings));
    if(req.command==="update_settings"){mock.settings={...mock.settings,...req.params};return reply(true,clone(mock.settings))}
    if(req.command==="select_cloud_profile"){mock.settings.selected_cloud_profile_id=req.params.profile_id||"official";const p=mock.settings.cloud_profiles.find(x=>x.id===mock.settings.selected_cloud_profile_id)||mock.settings.cloud_profiles[0];mock.settings.api_base=p.api_base;mock.products=normalizeProducts(BASE_PRODUCTS);return reply(true,clone(mock.settings))}
    if(req.command==="add_cloud_profile"||req.command==="pair_selfhost_profile"){const api=req.params.api;const id="profile_demo";const profile={id,name:req.params.name||hostOnly(api),api_base:api,web_origin:api,source:req.command==="pair_selfhost_profile"?"selfhost":"user",products:BASE_PRODUCTS.map(clone)};mock.settings.cloud_profiles=mock.settings.cloud_profiles.filter(p=>p.id!==id).concat([profile]);mock.settings.selected_cloud_profile_id=id;mock.settings.api_base=api;mock.products=normalizeProducts(BASE_PRODUCTS);return reply(true,clone(mock.settings))}
    if(req.command==="refresh_cloud_profile")return reply(true,clone(mock.settings));
    if(req.command==="remove_cloud_profile"){mock.settings.cloud_profiles=mock.settings.cloud_profiles.filter(p=>p.id!==req.params.profile_id);mock.settings.selected_cloud_profile_id="official";mock.settings.api_base=DEFAULT_API;mock.products=normalizeProducts(BASE_PRODUCTS);return reply(true,clone(mock.settings))}
    if(req.command==="toggle_authorization"){const p=mock.products.find(x=>x.id===req.params.product_id);const a=p?.accounts.find(x=>x.id===req.params.account||x.email===req.params.account);if(a){a.authorized=a.authorized==="paused"?"active":"paused";a.connected=a.authorized==="active"&&a.connection_enabled!==false;a.connection=a.connected?"connected":"disabled"}return reply(true,{ok:true})}
    if(req.command==="toggle_connection"){const p=mock.products.find(x=>x.id===req.params.product_id);const a=p?.accounts.find(x=>x.id===req.params.account||x.email===req.params.account);if(a){a.connection_enabled=!!req.params.enabled;a.connected=a.authorized!=="paused"&&a.connection_enabled;a.connection=a.connected?"connected":"disabled"}return reply(true,{ok:true,connection_enabled:!!req.params.enabled})}
    if(req.command==="remove_authorization"){const p=mock.products.find(x=>x.id===req.params.product_id);if(p)p.accounts=p.accounts.filter(x=>x.id!==req.params.account_id&&x.email!==req.params.account_id);return reply(true,{ok:true})}
    if(req.command==="preview_intent"){
      const base={product_id:"panda-burn",product_name:"Burn",cloud_origin:"https://token-burn.com",user_display_name:demoAccountLabel,user_id:"demo_user",capabilities:["relay.envelope","relay.ack"],local_policy:{version:"BRIDGE-RELAY-AUTH-v1",source_origin:"https://token-burn.com",capabilities:["relay.envelope","relay.ack"],product_authorization:{owner:"product-adapter",enforcement:"product-adapter",control:"computer-control"}}};
      return reply(true,base);
    }
    if(req.command==="claim_intent_preview"||req.command==="claim_intent_pending")return reply(true,{pending_id:"pending_demo",status:"pending"},null,slowConfirm?900:50);
    if(req.command==="confirm_pending_intent"||req.command==="claim_intent"){mock.products[0].accounts.push({id:"team",email:teamAccountLabel,authorized:"active",connection_enabled:true,connected:true,connection:"connected"});return reply(true,{ok:true},null,slowConfirm?900:50)}
    if(req.command==="open_web"||req.command==="start_worker")return reply(true,{ok:true});
    reply(false,null,"unknown command");
  }};
  if(new URLSearchParams(location.search).get("settings"))ui.view="settings";
  if(new URLSearchParams(location.search).get("sheet"))setTimeout(()=>window.PandaBridge.receive({type:"event",event:"deep_link",url:"panda-bridge://connect?intent=demo&api=https://api.bridge.chaos-realms.cc"}),120);
}
if(!window.ipc)installFallback();
applyTheme();
render();
refresh()
  .then(status=>{if(ui.view==="settings")probeAllServers();if((status.products||[]).some(p=>(p.accounts||[]).some(a=>a.authorized==="active"&&a.connection_enabled!==false)))window.PandaBridge.call("start_worker").catch(()=>{})})
  .catch(error=>{ui.booting=false;ui.statusError=String(error?.message||error);render()});
