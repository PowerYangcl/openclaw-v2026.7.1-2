// Control UI chat module implements chat welcome behavior.
import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { assistantAvatarFallbackUrl } from "../../../lib/agents/display.ts";
import { resolveAssistantTextAvatar, resolveChatAvatarRenderUrl } from "../../../lib/avatar.ts";

type ChatWelcomeProps = {
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  /** 鉴权 token：头像为本地相对路径时拼接到 img src，通过网关头像路由鉴权 */
  assistantAttachmentAuthToken?: string | null;
  basePath?: string;
  /** Optional per-agent quick-start phrases (shown instead of the default list). */
  quickStart?: string[];
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

const WELCOME_SUGGESTION_KEYS = [
  // "chat.welcome.suggestions.whatCanYouDo",
  // "chat.welcome.suggestions.summarizeRecentSessions",
  // "chat.welcome.suggestions.configureChannel",
  // "chat.welcome.suggestions.checkSystemHealth",
];

function resolveAssistantAvatarUrl(
  props: Pick<ChatWelcomeProps, "assistantAvatar" | "assistantAvatarUrl">,
): string | null {
  return resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
    identity: {
      avatar: props.assistantAvatar ?? undefined,
      avatarUrl: props.assistantAvatarUrl ?? undefined,
    },
  });
}

export function resolveAssistantDisplayAvatar(
  props: Pick<ChatWelcomeProps, "assistantAvatar" | "assistantAvatarUrl">,
): string | null {
  return resolveAssistantAvatarUrl(props) ?? resolveAssistantTextAvatar(props.assistantAvatar);
}

function resolveSuggestionTexts(props: ChatWelcomeProps): string[] {
  // Custom per-agent quickStart wins over the default i18n list.
  const custom = props.quickStart;
  if (Array.isArray(custom) && custom.length > 0) {
    const texts: string[] = [];
    for (const entry of custom) {
      if (typeof entry === "string" && entry.trim()) {
        texts.push(entry.trim());
      }
    }
    if (texts.length > 0) {
      return texts;
    }
  }
  return WELCOME_SUGGESTION_KEYS.map((key) => t(key));
}

/**
 * @description: welcome 页头像 img 直出时拼接网关鉴权 token，避免本地头像路径 401 破图。
 * @author yangchenglin11@jd.com
 * @date 2026年9月7日 16:10:00
 * @version v2026.8.28-1-build-dev
 */
function withAvatarToken(url: string | null, token: string | null | undefined): string | null {
  if (!url || !token || !url.startsWith("/")) {
    return url;
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function renderWelcomeState(props: ChatWelcomeProps) {
  const name = props.assistantName || "Assistant";
  const avatar = withAvatarToken(
    resolveAssistantAvatarUrl(props),
    props.assistantAttachmentAuthToken,
  );
  const avatarText = avatar ? null : resolveAssistantTextAvatar(props.assistantAvatar);
  const fallbackAvatarUrl = assistantAvatarFallbackUrl(props.basePath ?? "");
  const suggestions = resolveSuggestionTexts(props);

  return html`
    <div class="agent-chat__welcome" style="--agent-color: var(--accent)">
      <div class="agent-chat__welcome-glow"></div>
      ${avatar
        ? html`<img
            src=${avatar}
            alt=${name}
            style="width:56px; height:56px; border-radius:50%; object-fit:cover;"
          />`
        : avatarText
          ? html`<div class="agent-chat__avatar agent-chat__avatar--text" aria-label=${name}>
              ${avatarText}
            </div>`
          : html`<div class="agent-chat__avatar agent-chat__avatar--logo">
              <img src=${fallbackAvatarUrl} alt=${name} />
            </div>`}
      <h2>${name}</h2>
      <div class="agent-chat__badges">
        <span class="agent-chat__badge">${t("chat.welcome.ready")}</span>
      </div>
      ${
        /* GCS: 隐藏「在下方输入消息 · 输入 / 查看命令」提示文字
      <p class="agent-chat__hint">
        ${t("chat.welcome.hintBeforeShortcut")} <kbd>/</kbd>
        ${t("chat.welcome.hintAfterShortcut")}
      </p>
      */ ""
      }
      <div class="agent-chat__suggestions">
        ${suggestions.map((text) => {
          return html`
            <button
              type="button"
              class="agent-chat__suggestion"
              @click=${() => {
                props.onDraftChange(text);
                props.onSend();
              }}
            >
              ${text}
            </button>
          `;
        })}
      </div>
    </div>
  `;
}
