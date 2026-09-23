# SSH 已配置（2026-09-22）

A1 到 A2/A3/S1/S2/S3 的 ubuntu 公钥登录及 sudo -n 均已验证。
在 A1 上使用 `ssh crawl-a2`、`ssh crawl-a3`、`ssh crawl-s1`、`ssh crawl-s2`、`ssh crawl-s3`。

- 专用私钥：/home/ubuntu/.ssh/crawlsystem_deploy（600，仅在 A1）
- 公钥仅追加到各机 ubuntu authorized_keys；from=10.4.4.12,restrict 限制源地址与转发/PTY。
- 已有 SSH 授权保留，密码未写入项目文件；未更改服务器密码认证设置。
- 独立已知主机文件：/home/ubuntu/.ssh/crawlsystem_known_hosts。首次连接采用接受新主机策略，未做云控制台指纹交叉核对。
- 五个别名写入 /home/ubuntu/.ssh/config。
