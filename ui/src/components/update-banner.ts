// Control UI component renders update status and available-update actions.
import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { UpdateAvailable } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { icons } from "./icons.ts";

const UPDATE_BANNER_DISMISS_KEY = "openclaw:control-ui:update-banner-dismissed:v1";

type DismissedUpdateBanner = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

function loadDismissedUpdateBanner(): DismissedUpdateBanner | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(UPDATE_BANNER_DISMISS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DismissedUpdateBanner>;
    if (!parsed || typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
      dismissedAtMs: typeof parsed.dismissedAtMs === "number" ? parsed.dismissedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

function isDismissed(updateAvailable: UpdateAvailable): boolean {
  const dismissed = loadDismissedUpdateBanner();
  return Boolean(
    dismissed &&
    dismissed.latestVersion === updateAvailable.latestVersion &&
    dismissed.channel === updateAvailable.channel,
  );
}

function dismiss(updateAvailable: UpdateAvailable) {
  try {
    getSafeLocalStorage()?.setItem(
      UPDATE_BANNER_DISMISS_KEY,
      JSON.stringify({
        latestVersion: updateAvailable.latestVersion,
        channel: updateAvailable.channel,
        dismissedAtMs: Date.now(),
      } satisfies DismissedUpdateBanner),
    );
  } catch {
    // Best effort only; dismissing the banner is not a product failure.
  }
}

type UpdateBannerProps = {
  statusBanner: { tone: "danger" | "warn" | "info"; text: string } | null;
  updateAvailable: UpdateAvailable | null;
  updateRunning: boolean;
  connected: boolean;
  onUpdate: () => void | Promise<void>;
  onDismiss: () => void;
};

class UpdateBanner extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: UpdateBannerProps;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  override render() {
    const props = this.props;
    if (!props) {
      return nothing;
    }
    const updateAvailable = props.updateAvailable;
    return html`
      ${props.statusBanner
        ? html`<div class="callout ${props.statusBanner.tone}" role="alert">
            ${props.statusBanner.text}
          </div>`
        : nothing}
      ${nothing /* GCS: 隐藏更新提示横幅 */}
    `;
  }
}

if (!customElements.get("openclaw-update-banner")) {
  customElements.define("openclaw-update-banner", UpdateBanner);
}
