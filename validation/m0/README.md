# M0の独立した検証

製品実装ではない。空のDocker環境、Python 3.12以上、Node 22以上を使い、認証・最小RLS・PDF検査・1ページ生成の成立を確かめる。架空データのみ使用する。

```sh
cd validation/m0
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
npx playwright install --with-deps chromium --only-shell
.venv/bin/python run.py
```

macOSで別Docker contextを使う場合はM0_DOCKER_CONTEXTに指定する。起動時に一意のprefixを採番し、既存サービスを変更しない。15432/18080/18081はloopbackだけで公開する。秘密値は都度生成し、Git対象外のファイルへ保存する。

結果はcollected/に保存する。workflowが回収するのはこの結果と架空PDFのみ。終了時は作成したサービスだけ停止する。既存のファイル・volume・コンテナを削除する処理は持たない。

PDF serviceの実行には公式seccomp profile、SYS_CHROOT、tmpfs内のHOME/XDGが必要。sandboxを無効化する設定は使わない。検証イメージは検査用ツールを含むため製品配布イメージに流用しない。
