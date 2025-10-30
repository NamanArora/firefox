/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/sidebar/sidebar-panel-header.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
  SmartAssistEngine:
    "moz-src:///browser/components/genai/SmartAssistEngine.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const FULL_PAGE_URL = "chrome://browser/content/genai/smartAssistPage.html";
const ACTION_CHAT = "chat";
const ACTION_SEARCH = "search";

/**
 * A custom element for managing the smart assistant sidebar.
 */
export class SmartAssist extends MozLitElement {
  static properties = {
    userPrompt: { type: String },
    aiResponse: { type: String },
    conversationState: { type: Array },
    logState: { type: Array },
    mode: { type: String }, // "tab" | "sidebar"
    overrideNewTab: { type: Boolean },
    showLog: { type: Boolean },
    actionKey: { type: String }, // "chat" | "search"
    _isStreaming: { type: Boolean },
  };

  constructor() {
    super();
    this.userPrompt = "";
    this.conversationState = [];
    this.logState = [];
    this.showLog = false;
    this.mode = "sidebar";
    this.overrideNewTab = Services.prefs.getBoolPref(
      "browser.ml.smartAssist.overrideNewTab"
    );
    this.actionKey = ACTION_CHAT;
    this._currentBrowser = null;
    this._streamObserver = null;
    this._isStreaming = false;
    this._tabSelectListener = null;
    this._actions = {
      [ACTION_CHAT]: {
        label: "Submit",
        icon: "chrome://global/skin/icons/arrow-right.svg",
        run: this._actionChat,
      },
      [ACTION_SEARCH]: {
        label: "Search",
        icon: "chrome://global/skin/icons/search-glass.svg",
        run: this._actionSearch,
      },
    };
  }

  connectedCallback() {
    super.connectedCallback();

    // Get browser for the current tab
    this._currentBrowser = this._getBrowserForTab();

    // Load conversation for this browser/tab
    if (this._currentBrowser) {
      this._loadConversationForBrowser(this._currentBrowser);
    }

    // Set up tab switch listener
    this._tabSelectListener = () => {
      const newBrowser = this._getBrowserForTab();
      if (newBrowser && newBrowser !== this._currentBrowser) {
        // Unsubscribe from old browser's stream
        if (this._currentBrowser) {
          lazy.SmartAssistEngine.removeStreamObserver(this._currentBrowser);
        }

        // Switch to new browser
        this._currentBrowser = newBrowser;
        this._loadConversationForBrowser(newBrowser);
      }
    };

    const gBrowser = window.browsingContext.topChromeWindow.gBrowser;
    if (gBrowser?.tabContainer) {
      gBrowser.tabContainer.addEventListener("TabSelect", this._tabSelectListener);
    }

    if (this.mode === "sidebar" && this.overrideNewTab) {
      this._applyNewTabOverride(true);
    }
  }

  /**
   * Cleanup when component is disconnected
   */
  disconnectedCallback() {
    super.disconnectedCallback();

    // Remove stream observer for current browser
    if (this._currentBrowser) {
      lazy.SmartAssistEngine.removeStreamObserver(this._currentBrowser);
    }

    // Remove tab select listener
    if (this._tabSelectListener) {
      const gBrowser = window.browsingContext.topChromeWindow.gBrowser;
      if (gBrowser?.tabContainer) {
        gBrowser.tabContainer.removeEventListener("TabSelect", this._tabSelectListener);
      }
      this._tabSelectListener = null;
    }

    this._currentBrowser = null;
  }

  /**
   * Get the browser element for the currently selected tab
   *
   * @returns {Browser} The browser element
   */
  _getBrowserForTab() {
    const topWindow = window.browsingContext.topChromeWindow;
    return topWindow?.gBrowser?.selectedBrowser;
  }

  /**
   * Load conversation state for a specific browser/tab
   *
   * @param {Browser} browser - The browser element to load conversation for
   */
  _loadConversationForBrowser(browser) {
    if (!browser) {
      return;
    }

    // Get conversation from engine
    const conversation = lazy.SmartAssistEngine.getConversation(browser);
    this.conversationState = conversation || [];

    // Subscribe to stream updates for this browser
    lazy.SmartAssistEngine.addStreamObserver(browser, this._handleStreamUpdate.bind(this));

    // Check if currently streaming
    this._isStreaming = lazy.SmartAssistEngine.isStreaming(browser);

    // Request update to refresh UI
    this.requestUpdate?.();
  }

  /**
   * Handle streaming updates from the engine
   *
   * @param {object} update - The update object from streaming
   * @param {string} update.type - Type of update: 'text', 'tool_call', 'complete', 'error'
   */
  _handleStreamUpdate = update => {
    if (!this._currentBrowser) {
      return;
    }

    switch (update.type) {
      case "text":
        // Reload conversation to get updated content
        const conversation = lazy.SmartAssistEngine.getConversation(this._currentBrowser);
        this.conversationState = conversation || [];
        this.requestUpdate?.();
        break;

      case "tool_call":
        // Add tool call to log
        if (update.data) {
          this._updatelogState({
            content: update.data.content,
            result: update.data.result || "No result",
          });
        }
        break;

      case "complete":
        this._isStreaming = false;
        // Final reload to ensure we have complete conversation
        const finalConversation = lazy.SmartAssistEngine.getConversation(this._currentBrowser);
        this.conversationState = finalConversation || [];
        this.requestUpdate?.();
        break;

      case "error":
        this._isStreaming = false;
        console.error("Stream error:", update.error);
        this.requestUpdate?.();
        break;
    }
  };

  /**
   * Adds a new message to the conversation history.
   *
   * @param {object} chatEntry - A message object to add to the conversation
   * @param {("system"|"user"|"assistant")} chatEntry.role - The role of the message sender
   * @param {string} chatEntry.content - The text content of the message
   */
  _updateConversationState = chatEntry => {
    this.conversationState = [...this.conversationState, chatEntry];
  };

  _updatelogState = chatEntry => {
    const entryWithDate = { ...chatEntry, date: new Date().toLocaleString() };
    this.logState = [...this.logState, entryWithDate];
  };

  _handlePromptInput = async e => {
    try {
      const value = e.target.value;
      this.userPrompt = value;

      const intent = await lazy.SmartAssistEngine.getPromptIntent(value);
      this.actionKey = [ACTION_CHAT, ACTION_SEARCH].includes(intent)
        ? intent
        : ACTION_CHAT;
    } catch (error) {
      // Default to chat on error
      this.actionKey = ACTION_CHAT;
      console.error("Error determining prompt intent:", error);
    }
  };

  /**
   * Returns the current action object based on the actionKey
   */

  get inputAction() {
    return this._actions[this.actionKey];
  }

  _actionSearch = async () => {
    const searchTerms = (this.userPrompt || "").trim();
    if (!searchTerms) {
      return;
    }

    const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(window);
    const engine = isPrivate
      ? await Services.search.getDefaultPrivate()
      : await Services.search.getDefault();

    const submission = engine.getSubmission(searchTerms); // default to SEARCH (text/html)

    // getSubmission can return null if the engine doesn't have a URL
    // with a text/html response type. This is unlikely (since
    // SearchService._addEngineToStore() should fail for such an engine),
    // but let's be on the safe side.
    if (!submission) {
      return;
    }

    const triggeringPrincipal =
      Services.scriptSecurityManager.createNullPrincipal({});

    window.browsingContext.topChromeWindow.openLinkIn(
      submission.uri.spec,
      "current",
      {
        private: isPrivate,
        postData: submission.postData,
        inBackground: false,
        relatedToCurrent: true,
        triggeringPrincipal,
        policyContainer: null,
        targetBrowser: null,
        globalHistoryOptions: {
          triggeringSearchEngine: engine.name,
        },
      }
    );
  };

  _actionChat = async () => {
    const formattedPrompt = (this.userPrompt || "").trim();
    if (!formattedPrompt) {
      return;
    }

    // Clear the input immediately
    this.userPrompt = "";

    if (!this._currentBrowser) {
      console.error("No current browser available for chat");
      return;
    }

    try {
      // Set streaming flag
      this._isStreaming = true;

      // Start the stream via the engine
      // The stream will run in the background and notify us via _handleStreamUpdate
      await lazy.SmartAssistEngine.startStream(
        this._currentBrowser,
        formattedPrompt
      );

      // Immediately reload conversation to show user message
      const conversation = lazy.SmartAssistEngine.getConversation(this._currentBrowser);
      this.conversationState = conversation || [];
      this.requestUpdate?.();
    } catch (error) {
      console.error("Failed to start chat stream:", error);
      this._isStreaming = false;
      this.requestUpdate?.();
    }
  };

  /**
   * Mock Functionality to open full page UX
   *
   * @param {boolean} enable
   * Whether or not to override the new tab page.
   */
  _applyNewTabOverride(enable) {
    try {
      enable
        ? (lazy.AboutNewTab.newTabURL = FULL_PAGE_URL)
        : lazy.AboutNewTab.resetNewTabURL();
    } catch (e) {
      console.error("Failed to toggle new tab override:", e);
    }
  }

  _onToggleFullPage(e) {
    const isChecked = e.target.checked;
    Services.prefs.setBoolPref(
      "browser.ml.smartAssist.overrideNewTab",
      isChecked
    );
    this.overrideNewTab = isChecked;
    this._applyNewTabOverride(isChecked);
  }

  render() {
    const iconSrc = this.showLog
      ? "chrome://global/skin/icons/arrow-down.svg"
      : "chrome://global/skin/icons/arrow-up.svg";

    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/genai/content/smart-assist.css"
      />
      <div class="wrapper">
        ${
          this.mode === "sidebar"
            ? html` <sidebar-panel-header
                data-l10n-id="genai-smart-assist-sidebar-title"
                data-l10n-attrs="heading"
                view="viewGenaiSmartAssistSidebar"
              ></sidebar-panel-header>`
            : ""
        }

        <div>

          <!-- Conversation Panel -->
          <div>
            ${this.conversationState
              .filter(msg => msg.role !== "system")
              .map(
                msg =>
                  html`<div class="message ${msg.role}">
                    <strong>${msg.role}:</strong> ${msg.content}
                    ${msg.role === "assistant" && msg.content.length === 0
                      ? html`<span>Thinking</span>`
                      : ""}
                  </div>`
              )}
          </div>

          <!-- Log Panel -->
          ${
            this.logState.length !== 0
              ? html` <div class="log-panel">
                  <div class="log-header">
                    <span class="log-title">Log</span>
                    <moz-button
                      type="ghost"
                      iconSrc=${iconSrc}
                      @click=${() => {
                        this.showLog = !this.showLog;
                      }}
                    >
                    </moz-button>
                  </div>
                  ${this.showLog
                    ? html` <div class="log-entries">
                        ${this.logState.map(
                          data =>
                            html`<div class="log-entry">
                              <div><b>Message</b> : ${data.content}</div>
                              <div><b>Date</b> : ${data.date}</div>
                              <div>
                                <b>Tool Response</b> :
                                ${JSON.stringify(data.result)}
                              </div>
                            </div>`
                        )}
                      </div>`
                    : html``}
                </div>`
              : html``
          }
          </div>

          <!-- User Input -->
          <textarea
            .value=${this.userPrompt}
            class="prompt-textarea"
            @input=${e => this._handlePromptInput(e)}
          ></textarea>
          <moz-button
            iconSrc=${this.inputAction.icon}
            id="submit-user-prompt-btn"
            type="primary"
            size="small"
            @click=${this.inputAction.run}
            iconPosition="end"
          >
            ${this.inputAction.label}
          </moz-button>

          <!-- Footer - New Tab Override -->
          ${
            this.mode === "sidebar"
              ? html`<div class="footer">
                  <moz-checkbox
                    type="checkbox"
                    label="Mock Full Page Experience"
                    @change=${e => this._onToggleFullPage(e)}
                    ?checked=${this.overrideNewTab}
                  ></moz-checkbox>
                </div>`
              : ""
          }
        </div>
      </div>
    `;
  }
}

customElements.define("smart-assist", SmartAssist);
