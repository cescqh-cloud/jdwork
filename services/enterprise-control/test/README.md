# 本地集成测试

在 `services/enterprise-control` 目录运行。开发配置使用 PostgreSQL 16 和 Redis 7，数据库和缓存仅监听本机。容器停止后，内存盘上的测试数据会清空。

```powershell
bun install --frozen-lockfile
docker compose -f compose.dev.yaml up -d --wait
$env:ENTERPRISE_TEST_DATABASE_URL = 'postgres://enterprise_fixture:enterprise_fixture_only@127.0.0.1:55432/enterprise_control_test'
$env:ENTERPRISE_TEST_REDIS_URL = 'redis://:enterprise_fixture_only@127.0.0.1:56379/0'
bun --no-env-file test
```

两个测试连接变量均已设置时，集成用例才会连接真实实例。测试结束后关闭容器。

```powershell
docker compose -f compose.dev.yaml down
```

如有端口占用，在启动前设置 `ENTERPRISE_DEV_PG_PORT` 或 `ENTERPRISE_DEV_REDIS_PORT`，并同步修改对应的测试连接地址。两个测试变量均应指向为本次验证创建的实例。
