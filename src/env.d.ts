declare namespace Cloudflare {
  interface Env {
    SLACK_SIGNING_SECRET: string;
    SLACK_BOT_TOKEN: string;
    GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
    GOOGLE_INVENTORY_SHEET_ID: string;
    GOOGLE_INVENTORY_SHEET_TAB_NAME: string;
  }
}
