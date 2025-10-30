/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

/* eslint-disable-next-line mozilla/reject-import-system-module-from-non-system */
import { createEngine } from "chrome://global/content/ml/EngineProcess.sys.mjs";

const toolsConfig = [
  {
    type: "function",
    function: {
      name: "search_open_tabs",
      description:
        "Searches the user's open tabs for tabs that match the given type",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "the type of tabs I am looking for ie news, sports, etc",
          },
        },
        required: ["type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description:
        "Clicks an element on the current web page using a CSS selector",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "CSS selector for the element to click (e.g., 'button#submit', '.nav-link')",
          },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_forms",
      description:
        "Get all forms and input fields on the current page with their metadata, including selectors, types, labels, and placeholders",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill_input",
      description:
        "Fill a specific input field on the page with the provided text value",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "CSS selector for the input element to fill (e.g., 'input[name=\"email\"]', '#search-box')",
          },
          value: {
            type: "string",
            description: "The text value to fill into the input field",
          },
        },
        required: ["selector", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate_to_url",
      description:
        "Navigate to a URL in the current tab. Handles partial URLs (e.g., 'youtube', 'youtube.com') and full URLs (e.g., 'https://youtube.com'). Use this to open websites before interacting with them.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The URL to navigate to. Can be partial (e.g., 'youtube') or complete (e.g., 'https://youtube.com')",
          },
        },
        required: ["url"],
      },
    },
  },
];

/**
 * Searches the user's open tabs for tabs that match the given type
 *
 * @param {object}  args.type - type of tabs to search for
 * @returns
 */

const search_open_tabs = ({ type }) => {
  let win = lazy.BrowserWindowTracker.getTopWindow();
  let gBrowser = win.gBrowser;
  let tabs = gBrowser.tabs;
  const tabData = tabs.map(tab => {
    return {
      title: tab.label,
      url: tab.linkedBrowser.currentURI.spec,
    };
  });

  return {
    query: type,
    allTabs: tabData,
  };
};

/**
 * Clicks an element on the current page using a CSS selector
 *
 * @param {object} args.selector - CSS selector for the element to click
 * @returns {object} Result with success status and details
 */
const click_element = async ({ selector }) => {
  try {
    let win = lazy.BrowserWindowTracker.getTopWindow();
    let browser = win.gBrowser.selectedBrowser;

    // Send message to content process to perform click
    const result = await browser.browsingContext?.currentWindowContext
      .getActor("GenAI")
      .sendQuery("ClickElement", { selector });

    return result;
  } catch (error) {
    return {
      success: false,
      error: `Failed to click element: ${error.message}`,
    };
  }
};

/**
 * Get all forms and input fields on the current page
 *
 * @returns {object} Forms data with inputs and buttons
 */
const get_page_forms = async () => {
  try {
    let win = lazy.BrowserWindowTracker.getTopWindow();
    let browser = win.gBrowser.selectedBrowser;

    // Send message to content process to get forms data
    const result = await browser.browsingContext?.currentWindowContext
      .getActor("GenAI")
      .sendQuery("GetPageForms");

    return result;
  } catch (error) {
    return {
      success: false,
      error: `Failed to get page forms: ${error.message}`,
      forms: [],
    };
  }
};

/**
 * Fill an input field with the provided value
 *
 * @param {object} args.selector - CSS selector for the input element
 * @param {object} args.value - Text value to fill
 * @returns {object} Result with success status
 */
const fill_input = async ({ selector, value }) => {
  try {
    let win = lazy.BrowserWindowTracker.getTopWindow();
    let browser = win.gBrowser.selectedBrowser;

    // Send message to content process to fill input
    const result = await browser.browsingContext?.currentWindowContext
      .getActor("GenAI")
      .sendQuery("FillInput", { selector, value });

    return result;
  } catch (error) {
    return {
      success: false,
      error: `Failed to fill input: ${error.message}`,
    };
  }
};

/**
 * Navigate to a URL in the current tab
 *
 * @param {object} args.url - URL to navigate to (can be partial)
 * @returns {object} Result with success status and normalized URL
 */
const navigate_to_url = ({ url }) => {
  try {
    let win = lazy.BrowserWindowTracker.getTopWindow();
    let browser = win.gBrowser.selectedBrowser;

    // Use Firefox's built-in URL fixup to handle partial URLs
    let fixupInfo;
    try {
      fixupInfo = Services.uriFixup.getFixupURIInfo(
        url,
        Services.uriFixup.FIXUP_FLAG_NONE
      );
    } catch (e) {
      return {
        success: false,
        error: `Invalid URL: ${url}`,
      };
    }

    const fixedUrl = fixupInfo.preferredURI.spec;

    // Navigate in current tab
    const options = {
      triggeringPrincipal:
        Services.scriptSecurityManager.createNullPrincipal({}),
    };

    browser.fixupAndLoadURIString(url, options);

    return {
      success: true,
      originalUrl: url,
      navigatedTo: fixedUrl,
      message: `Navigating to ${fixedUrl}`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to navigate: ${error.message}`,
    };
  }
};

/**
 * Smart Assist Engine
 */
export const SmartAssistEngine = {
  toolMap: {
    search_open_tabs,
    click_element,
    get_page_forms,
    fill_input,
    navigate_to_url,
  },

  /**
   * Exposing createEngine for testing purposes.
   */

  _createEngine: createEngine,

  /**
   * Creates an OpenAI engine instance configured with Smart Assists preferences.
   *
   * @returns {Promise<object>} The configured engine instance
   */
  async createOpenAIEngine() {
    try {
      const engineInstance = await this._createEngine({
        apiKey: Services.prefs.getStringPref("browser.ml.smartAssist.apiKey"),
        backend: "openai",
        baseURL: Services.prefs.getStringPref(
          "browser.ml.smartAssist.endpoint"
        ),
        modelId: Services.prefs.getStringPref("browser.ml.smartAssist.model"),
        modelRevision: "main",
        taskName: "text-generation",
      });
      return engineInstance;
    } catch (error) {
      console.error("Failed to create OpenAI engine:", error);
      throw error;
    }
  },

  /**
   * Stream assistant output with tool-call support.
   * Yields assistant text chunks as they arrive. If the model issues tool calls,
   * we execute them locally, append results to the conversation, and continue
   * streaming the model’s follow-up answer. Repeats until no more tool calls.
   *
   * @param {Array<{role:string, content?:string, tool_call_id?:string, tool_calls?:any}>} messages
   * @yields {string} Assistant text chunks
   */
  async *fetchWithHistory(messages) {
    const engineInstance = await this.createOpenAIEngine();

    // We'll mutate a local copy of the thread as we loop
    let convo = Array.isArray(messages) ? [...messages] : [];

    // Helper to run the model once (streaming) on current convo
    const streamModelResponse = () =>
      engineInstance.runWithGenerator({
        streamOptions: { enabled: true },
        tool_choice: "auto",
        tools: toolsConfig,
        args: convo,
      });

    // Keep calling until the model finishes without requesting tools
    while (true) {
      let pendingToolCalls = null;

      // 1) First pass: stream tokens; capture any toolCalls
      for await (const chunk of streamModelResponse()) {
        // Stream assistant text to the UI
        if (chunk?.text) {
          yield chunk.text;
        }

        // Capture tool calls (do not echo raw tool plumbing to the user)
        if (chunk?.toolCalls?.length) {
          pendingToolCalls = chunk.toolCalls;
        }
      }

      // 2) Watch for tool calls; if none, we are done
      if (!pendingToolCalls || pendingToolCalls.length === 0) {
        return;
      }

      // 3) Build the assistant tool_calls message exactly as expected by the API
      const assistantToolMsg = {
        role: "assistant",
        tool_calls: pendingToolCalls.map(toolCall => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        })),
      };

      // 4) Execute each tool locally and create a tool message with the result
      const toolResultMessages = [];
      for (const toolCall of pendingToolCalls) {
        const { id, function: functionSpec } = toolCall;
        const name = functionSpec?.name || "";
        let toolParams = {};

        try {
          toolParams = functionSpec?.arguments
            ? JSON.parse(functionSpec.arguments)
            : {};
        } catch {
          toolResultMessages.push({
            role: "tool",
            tool_call_id: id,
            content: JSON.stringify({ error: "Invalid JSON arguments" }),
          });
          continue;
        }

        let result;
        try {
          // Call the appropriate tool by name
          const toolFunc = this.toolMap[name];
          if (typeof toolFunc !== "function") {
            throw new Error(`No such tool: ${name}`);
          }

          result = await toolFunc(toolParams);

          // Create special tool call log message to show in the UI log panel
          const assistantToolCallLogMsg = {
            role: "assistant",
            content: `Tool Call: ${name} with parameters: ${JSON.stringify(
              toolParams
            )}`,
            type: "tool_call_log",
            result,
          };
          convo.push(assistantToolCallLogMsg);
          yield assistantToolCallLogMsg;
        } catch (e) {
          result = { error: `Tool execution failed: ${String(e)}` };
        }

        toolResultMessages.push({
          role: "tool",
          tool_call_id: id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

      convo = [...convo, assistantToolMsg, ...toolResultMessages];
    }
  },

  /**
   * Gets the intent of the prompt using a text classification model.
   *
   * @param {string} prompt
   * @returns {string} "search" | "chat"
   */

  async getPromptIntent(query) {
    return "chat";
    try {
      const engine = await this._createEngine({
        featureId: "smart-intent",
        modelId: "mozilla/mobilebert-query-intent-detection",
        modelRevision: "v0.1.0",
        taskName: "text-classification",
      });
      const resp = await engine.run({ args: [[query]] });
      return resp[0].label.toLowerCase();
    } catch (error) {
      console.error("Error using intent detection model:", error);
      throw error;
    }
  },
};
