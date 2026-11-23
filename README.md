# Gap MCP (گپ)

[![npm](https://img.shields.io/npm/v/@nabuxai/gap-mcp)](https://www.npmjs.com/package/@nabuxai/gap-mcp) [![CI](https://github.com/NabuxAi/gap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/NabuxAi/gap-mcp/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-blue)

یک سرور MCP برای پیام‌رسان گپ، تا دستیار هوش مصنوعی (Claude، Cursor، ChatGPT و …) بتواند پیام بخواند و بفرستد. دو حالت دارد:

- **حالت بات** — پلتفرم بات گپ: متن، فایل، ویرایش، حذف. دریافت پیام فقط با وب‌هوک است و این‌جا پشتیبانی نمی‌شود.
- **حالت وب (اکانت خودتان)** — Gap Web در یک پنجره‌ی Chrome محلی با پروفایل جدا باز می‌شود و با اکانت خودتان کار می‌کند. یک بار خودتان وارد می‌شوید (کد ورود و رمز دومرحله‌ای را **فقط خودتان در همان پنجره** می‌زنید) و ورود ذخیره می‌ماند. 26 قابلیت از 26.

> English summary below.

## نصب در Claude Code / Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "gap": {
      "command": "npx",
      "args": ["-y", "@nabuxai/gap-mcp"],
      "env": {
        "NABU_MESSAGING_ENABLE_SEND": "1",
        "GAP_BOT_TOKEN": "…",
        "GAP_ALLOWED_CHAT_IDS": "…",
        "NABU_BROWSER_ENABLE": "1",
        "GAP_WEB_ALLOWED_CHATS": "me"
      }
    }
  }
}
```

یا در Claude Code:

```bash
claude mcp add gap -e NABU_BROWSER_ENABLE=1 -e GAP_WEB_ALLOWED_CHATS=me -- npx -y @nabuxai/gap-mcp
```

همه‌ی متغیرها در [`.env.example`](.env.example) توضیح داده شده‌اند. توکن بات: پنل my.gap.im. حالت وب به Chrome نصب‌شده نیاز دارد (یا `CHROME_EXECUTABLE_PATH`).

**IP ایران:** وب‌اپ و API بیشتر پیام‌رسان‌های ایرانی فقط از IP ایران جواب می‌دهند. اگر سیستم شما IP خارج دارد، از یک سرور داخل ایران تونل بزنید و `NABU_BROWSER_PROXY=socks5://127.0.0.1:1088` بدهید:

```bash
ssh -N -D 127.0.0.1:1088 <server-in-iran>
```

## شروع حالت وب

1. `gap_web_open` — پنجره باز می‌شود.
2. اگر وارد نیستید: `gap_web_login_start` با شماره موبایل؛ بعد کد را خودتان در پنجره بزنید.
3. `gap_web_list_chats`، `gap_web_read_chat`، `gap_web_send_message` و …

## قابلیت‌های حالت وب

| قابلیت | ابزار | |
|---|---|---|
| فهرست گفتگوها | `gap_web_list_chats` | ✅ |
| خواندن پیام‌ها | `gap_web_read_chat` | ✅ |
| ارسال متن (و پاسخ) | `gap_web_send_message` | ✅ |
| ارسال عکس و فایل | `gap_web_send_file` | ✅ |
| ویرایش پیام | `gap_web_editText` | ✅ |
| حذف پیام | `gap_web_deleteMessages` | ✅ |
| هدایت (فوروارد) | `gap_web_forwardMessages` | ✅ |
| سنجاق کردن | `gap_web_pinMessage` | ✅ |
| خوانده‌شده کردن | `gap_web_markRead` | ✅ |
| ارسال موقعیت | `gap_web_sendLocation` | ✅ |
| ارسال مخاطب | `gap_web_sendContact` | ✅ |
| ارسال نظرسنجی | `gap_web_sendPoll` | ✅ |
| اطلاعات گفتگو | `gap_web_getChatInfo` | ✅ |
| اعضا | `gap_web_getMembers` | ✅ |
| جستجوی پیام | `gap_web_searchMessages` | ✅ |
| دانلود رسانه | `gap_web_downloadMedia` | ✅ |
| پیام‌های نخوانده | `gap_web_getUnread` | ✅ |
| مخاطبان | `gap_web_getContacts` | ✅ |
| ساخت گروه/کانال | `gap_web_createChat` | ✅ |
| تغییر نام/توضیح | `gap_web_updateChat` | ✅ |
| لینک دعوت | `gap_web_getInviteLink` | ✅ |
| عضویت | `gap_web_joinChat` | ✅ |
| ترک گفتگو | `gap_web_leaveChat` | ✅ |
| افزودن عضو | `gap_web_addMembers` | ✅ |
| حذف عضو | `gap_web_removeMember` | ✅ |
| ادمین کردن | `gap_web_setAdmin` | ✅ |

**محدودیت‌ها:** Polls and pins work only in groups/channels (pins need admin); polls are single-answer with no anonymity option; removeMember cannot ban; member lists are what Gap shows this account (often empty for channels you do not run); user ids for member ops are numeric.

## قفل‌های امنیتی

| کار | چه لازم دارد |
|---|---|
| خواندن | توکن بات، یا پنجره‌ی واردشده و `NABU_BROWSER_ENABLE=1` |
| نوشتن در گفتگو (ارسال، ویرایش، حذف، سنجاق، فوروارد…) | `confirm: true`، گفتگو در `GAP_ALLOWED_CHAT_IDS` (بات) یا `GAP_WEB_ALLOWED_CHATS` (وب)، و `NABU_MESSAGING_ENABLE_SEND=1` |
| تغییر اکانت (ساخت/عضویت/ترک گفتگو، اعضا، ادمین) | همه‌ی موارد بالا و `NABU_WEB_ALLOW_ACCOUNT_CHANGES=1` |

ارسال انبوه وجود ندارد: هر بار یک گفتگو، و حداکثر ۵ عضو در هر بار افزودن.

**هشدار:** حالت وب اکانت شخصی شما را خودکار می‌کند و ممکن است خلاف قوانین گپ باشد؛ استفاده‌ی نادرست می‌تواند به محدود شدن اکانت برسد. هر کس به پوشه‌ی پروفایل مرورگر (`~/.nabuxai/iranian-messaging-profiles/gap`) دسترسی داشته باشد به اکانت شما دسترسی دارد. جزئیات در [SECURITY.md](SECURITY.md).

---

## English

An MCP server for Gap. **Bot mode** — Gap bot platform: text, files, edit, delete. Incoming messages arrive only by webhook, which is not covered here. **Web mode** drives Gap Web in a local Chrome window with your own signed-in account (you type the sign-in code yourself in that window; the session is kept in a local profile). 26 of 26 web operations are available here; call `gap_web_capabilities` for the live list.

Install: `npx -y @nabuxai/gap-mcp` (see the JSON config above; every variable is documented in `.env.example`). Writes need `confirm: true`, an allowlisted chat and `NABU_MESSAGING_ENABLE_SEND=1`; account changes also need `NABU_WEB_ALLOW_ACCOUNT_CHANGES=1`. There is no bulk sending. Most Iranian messenger hosts only answer Iranian IPs; use `NABU_BROWSER_PROXY` with a SOCKS tunnel if needed.

Built on [`@nabuxai/iranian-messaging-core`](https://github.com/NabuxAi/iranian-messaging-core). Sister servers: [eitaa-mcp](https://github.com/NabuxAi/eitaa-mcp), [rubika-mcp](https://github.com/NabuxAi/rubika-mcp), [bale-mcp](https://github.com/NabuxAi/bale-mcp), [soroushplus-mcp](https://github.com/NabuxAi/soroushplus-mcp), [gap-mcp](https://github.com/NabuxAi/gap-mcp).

MIT © NabuxAI. Community project; not affiliated with or endorsed by Gap.
