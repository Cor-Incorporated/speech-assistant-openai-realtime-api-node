#  Twilio VoiceとOpenAI Realtime APIを使用した音声アシスタント（Node.js）

> **このリポジトリは Cor.株式会社が管理する公開派生実装です。**
> ベース実装は Twilio 公式サンプル `twilio-samples/speech-assistant-openai-realtime-api-node` (MIT License, Copyright (c) 2024 Twilio Inc.) を派生したものです。OpenAI Realtime API は本実装の利用先 API として呼び出します。
> 詳細は [HISTORICAL_RECORD.md](./HISTORICAL_RECORD.md) を、依存OSSは [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) を参照してください。
> デプロイ先ごとのシステムプロンプト、運用識別子、顧客固有設定は本リポジトリには含めません。

このアプリケーションは、Node.js、[Twilio Voice](https://www.twilio.com/docs/voice)と[Media Streams](https://www.twilio.com/docs/voice/media-streams)、[OpenAIのRealtime API](https://platform.openai.com/docs/)を使用して、AIアシスタントとの電話会話を可能にする方法を示しています。 

このアプリケーションは、OpenAI Realtime APIとTwilioとの間でウェブソケットを開き、音声オーディオを一方からもう一方に送信して、二方向の会話を可能にします。

[ここ](https://www.twilio.com/en-us/voice-ai-assistant-openai-realtime-api-node)で、コードのチュートリアル概要を参照してください。

このアプリケーションは、OpenAIのRealtime APIと共に以下のTwilio製品を使用しています：
- Voice (およびTwiML, Media Streams)
- 電話番号

## 必要条件

このアプリを使用するには、以下が必要です：

- **Node.js 18+** 開発には`18.20.4`を使用しました。[ここ](https://nodejs.org/)からダウンロードできます。
- **Twilioアカウント。** 無料トライアルに[ここ](https://www.twilio.com/try-twilio)から登録できます。
- **Voice機能を持つTwilio番号。** [ここ](https://help.twilio.com/articles/223135247-How-to-Search-for-and-Buy-a-Twilio-Phone-Number-from-Console)に、電話番号を購入するための手順が記載されています。
- **OpenAIアカウントとOpenAI APIキー。** [ここ](https://platform.openai.com/)から登録できます。
  - **OpenAI Realtime APIへのアクセス。**

## ローカルセットアップ

ローカルで開発とテストを行うためのアプリを起動するには、以下の4つの必須ステップがあります：
1. ngrokや他のトンネリングソリューションを使用して、ローカルサーバーをインターネットに公開し、テストを行います。ngrokは[ここ](https://ngrok.com/)からダウンロードできます。
2. パッケージをインストール
3. Twilioの設定
4. .envファイルを更新

### ngrokトンネルを開く
ローカルで開発とテストを行う際には、ローカル開発サーバーへのリクエストをフォワードするためのトンネルを開く必要があります。これらの手順ではngrokを使用します。

ターミナルを開いて、以下を実行します：
```
ngrok http 5050
```
トンネルが開いた後、`Forwarding` URLをコピーします。それは`https://[your-ngrok-subdomain].ngrok.app`のようになります。これは、Twilio番号の設定で必要になります。

注意：上記の`ngrok`コマンドは、デフォルトでポート`5050`で動作する開発サーバーにフォワードします。このアプリケーションでは、`index.js`でポートが設定されています。`PORT`をオーバーライドする場合は、`ngrok`コマンドも更新する必要があります。

各回`ngrok http`コマンドを実行すると、新しいURLが作成され、以下で参照されるすべての場所で更新する必要があります。

### 必要なパッケージをインストール

ターミナルを開いて、以下を実行します：
```
npm install
```

### Twilioの設定

#### ngrok URLを電話番号にポイント
[Twilio Console](https://console.twilio.com/)で、**Phone Numbers** > **Manage** > **Active Numbers**に移動し、このアプリのために購入した電話番号をクリックします。

電話番号の設定で、最初の**A call comes in**ドロップダウンを**Webhook**に変更し、ngrokのフォワードURL（上記で参照）を `/incoming-call`に続けて貼り付けます。例えば、`https://[your-ngrok-subdomain].ngrok.app/incoming-call`。その後、**Save configuration**をクリックします。

### .envファイルを更新

`.env`ファイルを作成するか、`.env.example`ファイルを`.env`にコピーします：
```
cp .env.example .env
```

`.env`ファイルで、`OPENAI_API_KEY`を**必要条件**で指定されたOpenAI APIキーに更新します。Realtime APIの疎通確認には有効なAPIキーが必要です。

## アプリを実行
ngrokが動作し、依存関係がインストールされ、Twilioが適切に設定され、`.env`が設定された後、以下のコマンドで開発サーバーを実行します：
```
npm run start
```

ローカルのHTTP/TwiMLだけを確認する場合は、サーバー起動後に別のターミナルで以下を実行します：
```
npm run smoke:local
```

OpenAI Realtime APIへのWebSocket接続だけを確認する場合は、以下を実行します：
```
npm run check:realtime
```
## アプリをテスト
開発サーバーが動作している間に、**必要条件**で購入した電話番号に電話をかけてください。紹介後、AIアシスタントと話すことができます。楽しんでください！
