/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "shortcutsDelay",
  "browser.ml.chat.shortcuts.longPress"
);

ChromeUtils.defineESModuleGetters(lazy, {
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
});

// Events to register after shortcuts are shown
const HIDE_EVENTS = ["pagehide", "resize", "scroll"];

/**
 * JSWindowActor to detect content page events to send GenAI related data.
 */
export class GenAIChild extends JSWindowActorChild {
  mouseUpTimeout = null;
  downSelection = null;
  downTimeStamp = 0;
  debounceDelay = 200;
  pendingHide = false;

  registerHideEvents() {
    this.document.addEventListener("selectionchange", this);
    HIDE_EVENTS.forEach(ev =>
      this.contentWindow.addEventListener(ev, this, true)
    );
    this.pendingHide = true;
  }

  removeHideEvents() {
    this.document.removeEventListener("selectionchange", this);
    HIDE_EVENTS.forEach(ev =>
      this.contentWindow?.removeEventListener(ev, this, true)
    );
    this.pendingHide = false;
  }

  handleEvent(event) {
    const sendHide = () => {
      // Only remove events and send message if shortcuts are actually visible
      if (this.pendingHide) {
        this.sendAsyncMessage("GenAI:HideShortcuts", event.type);
        this.removeHideEvents();
      }
    };

    switch (event.type) {
      case "mousedown":
        this.downSelection = this.getSelectionInfo().selection;
        this.downTimeStamp = event.timeStamp;
        sendHide();
        break;
      case "mouseup": {
        // Only handle plain clicks
        if (
          event.button ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return;
        }

        // Clear any previously scheduled mouseup actions
        if (this.mouseUpTimeout) {
          this.contentWindow.clearTimeout(this.mouseUpTimeout);
        }

        const { screenX, screenY } = event;

        this.mouseUpTimeout = this.contentWindow.setTimeout(() => {
          const selectionInfo = this.getSelectionInfo();
          const delay = event.timeStamp - this.downTimeStamp;

          // Only send a message if there's a new selection or a long press
          if (
            (selectionInfo.selection &&
              selectionInfo.selection !== this.downSelection) ||
            delay > lazy.shortcutsDelay
          ) {
            this.sendAsyncMessage("GenAI:ShowShortcuts", {
              ...selectionInfo,
              contentType: "selection",
              delay,
              screenXDevPx: screenX * this.contentWindow.devicePixelRatio,
              screenYDevPx: screenY * this.contentWindow.devicePixelRatio,
            });
            this.registerHideEvents();
          }

          // Clear the timeout reference after execution
          this.mouseUpTimeout = null;
        }, this.debounceDelay);

        break;
      }
      case "pagehide":
      case "resize":
      case "scroll":
      case "selectionchange":
        // Hide if selection might have shifted away from shortcuts
        sendHide();
        break;
    }
  }

  /**
   * Provide the selected text and input type.
   *
   * @returns {object} selection info
   */
  getSelectionInfo() {
    // Handle regular selection outside of inputs
    const { activeElement } = this.document;
    const selection = this.contentWindow.getSelection()?.toString().trim();
    if (selection) {
      return {
        inputType: activeElement.closest("[contenteditable]")
          ? "contenteditable"
          : "",
        selection,
      };
    }

    // Selection within input elements
    const { selectionStart, value } = activeElement;
    if (selectionStart != null && value != null) {
      return {
        inputType: activeElement.localName,
        selection: value.slice(selectionStart, activeElement.selectionEnd),
      };
    }
    return { inputType: "", selection: "" };
  }

  /**
   * Handles incoming messages from the browser
   *
   * @param {object} message - The message object containing name
   * @param {string} message.name - The name of the message
   * @param {object} message.data - The data object of the message
   */
  async receiveMessage({ name, data }) {
    switch (name) {
      case "GetReadableText":
        return this.getContentText();
      case "AutoSubmit":
        return await this.autoSubmitClick(data);
      case "ClickElement":
        return await this.clickElement(data);
      case "GetPageForms":
        return await this.getPageForms();
      case "FillInput":
        return await this.fillInput(data);
      default:
        return null;
    }
  }

  /**
   * Find the prompt editable element within a timeout
   * Return the element or null
   *
   * @param {Window} win - the target window
   * @param {number} [tms=1000] - time in ms
   */
  async findTextareaEl(win, tms = 1000) {
    const start = win.performance.now();
    let el;
    while (
      !(el = win.document.querySelector(
        '#prompt-textarea, [contenteditable], [role="textbox"]'
      )) &&
      win.performance.now() - start < tms
    ) {
      await new Promise(r => win.requestAnimationFrame(r));
    }
    return el;
  }

  /**
   * Automatically submit the prompt
   *
   * @param {string} promptText - the prompt to send
   */
  async autoSubmitClick({ promptText = "" } = {}) {
    const win = this.contentWindow;
    if (!win || win._autosent) {
      return;
    }

    // Ensure the DOM is ready before querying elements
    if (win.document.readyState === "loading") {
      await new Promise(r =>
        win.addEventListener("DOMContentLoaded", r, { once: true })
      );
    }

    const editable = await this.findTextareaEl(win);
    if (!editable) {
      return;
    }

    if (!editable.textContent) {
      editable.textContent = promptText;
      editable.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
    }

    // Explicitly wait for the button is ready
    await new Promise(r => win.requestAnimationFrame(r));

    // Simulating click to avoid SPA router rewriting (?prompt-textarea=)
    const submitBtn =
      win.document.querySelector('button[data-testid="send-button"]') ||
      win.document.querySelector('button[aria-label="Send prompt"]') ||
      win.document.querySelector('button[aria-label="Send message"]');

    if (submitBtn) {
      submitBtn.click();
      win._autosent = true;
    }

    // Ensure clean up textarea only for chatGPT and mochitest
    if (
      win._autosent &&
      (/chatgpt\.com/i.test(win.location.host) ||
        win.location.pathname.includes("file_chat-autosubmit.html"))
    ) {
      win.setTimeout(() => {
        if (editable.textContent) {
          editable.textContent = "";
          editable.dispatchEvent(
            new win.InputEvent("input", { bubbles: true })
          );
        }
      }, 500);
    }
  }

  /**
   * Click an element on the page by CSS selector
   *
   * @param {object} data - The data object containing the selector
   * @param {string} data.selector - CSS selector for the element to click
   * @returns {object} Result with success status and details
   */
  async clickElement({ selector }) {
    try {
      const win = this.contentWindow;
      const doc = win.document;

      // Wait for element if needed
      const element = doc.querySelector(selector);

      if (!element) {
        return {
          success: false,
          error: `Element not found: ${selector}`,
        };
      }

      // Check if element is visible and clickable
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return {
          success: false,
          error: `Element is not visible: ${selector}`,
        };
      }

      // Perform the click
      element.click();

      return {
        success: true,
        selector,
        elementType: element.tagName.toLowerCase(),
        text: element.textContent?.trim().slice(0, 50) || "",
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get all forms and input fields on the page with metadata
   *
   * @returns {object} Forms data with inputs and buttons
   */
  async getPageForms() {
    try {
      const win = this.contentWindow;
      const doc = win.document;

      const forms = [];

      // Helper to generate unique selector
      const generateSelector = element => {
        if (element.id) {
          return `#${element.id}`;
        }
        if (element.name) {
          return `${element.tagName.toLowerCase()}[name="${element.name}"]`;
        }
        if (element.className) {
          const classes = element.className.split(" ").filter(c => c);
          if (classes.length > 0) {
            return `${element.tagName.toLowerCase()}.${classes[0]}`;
          }
        }
        return element.tagName.toLowerCase();
      };

      // Get label text for input
      const getLabel = element => {
        if (element.labels && element.labels.length > 0) {
          return element.labels[0].textContent?.trim() || "";
        }
        const ariaLabel = element.getAttribute("aria-label");
        if (ariaLabel) {
          return ariaLabel;
        }
        return "";
      };

      // Collect all input elements
      const inputs = doc.querySelectorAll(
        'input[type="text"], input[type="search"], input[type="email"], ' +
          'input[type="tel"], input[type="url"], input[type="password"], ' +
          'input:not([type]), textarea, [contenteditable="true"], ' +
          '[role="textbox"], [role="searchbox"]'
      );

      const inputData = Array.from(inputs).map(input => {
        const rect = input.getBoundingClientRect();
        return {
          selector: generateSelector(input),
          type: input.type || input.getAttribute("role") || "text",
          placeholder: input.placeholder || "",
          label: getLabel(input),
          ariaLabel: input.getAttribute("aria-label") || "",
          value: input.value || input.textContent || "",
          visible: rect.width > 0 && rect.height > 0,
          tagName: input.tagName.toLowerCase(),
        };
      });

      // Collect all buttons
      const buttons = doc.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      );

      const buttonData = Array.from(buttons).map(button => {
        const rect = button.getBoundingClientRect();
        return {
          selector: generateSelector(button),
          text: button.textContent?.trim() || button.value || "",
          type: button.type || "button",
          ariaLabel: button.getAttribute("aria-label") || "",
          visible: rect.width > 0 && rect.height > 0,
          tagName: button.tagName.toLowerCase(),
        };
      });

      forms.push({
        inputs: inputData,
        buttons: buttonData,
      });

      return {
        success: true,
        forms,
        pageUrl: doc.location.href,
        pageTitle: doc.title,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        forms: [],
      };
    }
  }

  /**
   * Fill an input field with text
   *
   * @param {object} data - The data object
   * @param {string} data.selector - CSS selector for the input
   * @param {string} data.value - Text value to fill
   * @returns {object} Result with success status
   */
  async fillInput({ selector, value }) {
    try {
      const win = this.contentWindow;
      const doc = win.document;

      const element = doc.querySelector(selector);

      if (!element) {
        return {
          success: false,
          error: `Element not found: ${selector}`,
        };
      }

      // Check if element is visible
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return {
          success: false,
          error: `Element is not visible: ${selector}`,
        };
      }

      // Fill based on element type
      if (
        element.hasAttribute("contenteditable") ||
        element.getAttribute("role") === "textbox"
      ) {
        element.textContent = value;
        element.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
      } else {
        element.value = value;
        element.dispatchEvent(new win.Event("input", { bubbles: true }));
        element.dispatchEvent(new win.Event("change", { bubbles: true }));
      }

      return {
        success: true,
        selector,
        value,
        elementType: element.tagName.toLowerCase(),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get readable article text or whole innerText from the content side.
   *
   * @returns {string} text from the page
   */
  async getContentText() {
    const win = this.browsingContext?.window;
    const doc = win?.document;
    const article = await lazy.ReaderMode.parseDocument(doc);
    return {
      readerMode: !!article?.textContent,
      selection: (article?.textContent || doc?.body?.innerText || "")
        .trim()
        // Replace duplicate whitespace with either a single newline or space
        .replace(/(\s*\n\s*)|\s{2,}/g, (_, newline) => (newline ? "\n" : " ")),
    };
  }
}
