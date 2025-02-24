(function (global) {
  "use strict";

  // Define the endpoint.
  const ENDPOINT = "https://userqueryapi-570ltrrel-nathanielangafors-projects.vercel.app/api/events";

  const USERQUERY = {};

  // Internal state variables.
  let _initialized = false;
  let _siteId = null;
  let _userId = null;
  let _config = {};
  let _eventListeners = [];
  let _eventBatch = [];
  let _batchTimer = null;

  // Default configuration values.
  const DEFAULT_CONFIG = {
    siteId: "UNKNOWN_SITE",
    batchInterval: 5000 // in milliseconds
  };

  // Global mapping for ZenIDs.
  const __zenMapping = {};

  /**
   * Generate a signature for an element based on its static properties.
   */
  function generateElementSignature(element) {
    if (!element || !element.tagName) return null;
    const parts = [element.tagName.toLowerCase()];
    if (element.id) parts.push(`id:${element.id}`);
    if (element.className) parts.push(`class:${element.className}`);
    const nameAttr = element.getAttribute("name");
    if (nameAttr) parts.push(`name:${nameAttr}`);
    const typeAttr = element.getAttribute("type");
    if (typeAttr) parts.push(`type:${typeAttr}`);
    const text = element.textContent.trim();
    if (text && text.length < 50) {
      parts.push(`text:${text}`);
    }
    return parts.join("|");
  }

  /**
   * Compute a 32-bit FNV-1a hash for a given string.
   */
  function fnv32a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Generate a stable ZenID for the given element.
   */
  function generateStableZenId(element) {
    const signature = generateElementSignature(element);
    if (!signature) return null;

    const baseHash = "zen-" + fnv32a(signature);
    if (!(signature in __zenMapping)) {
      __zenMapping[signature] = { id: baseHash, count: 1 };
      return baseHash;
    } else {
      const entry = __zenMapping[signature];
      const newId = entry.count === 1 ? baseHash + "-2" : baseHash + "-" + (entry.count + 1);
      entry.count++;
      return newId;
    }
  }

  /**
   * Label a single element with a stable data-zenid attribute.
   */
  function labelElement(el) {
    if (!el.hasAttribute("data-zenid")) {
      const zenId = generateStableZenId(el);
      if (zenId) {
        el.setAttribute("data-zenid", zenId);
      }
    }
  }

  /**
   * Retrieve or create a persistent user ID stored in localStorage.
   */
  function getOrCreateUserId() {
    let existingId = null;
    try {
      existingId = localStorage.getItem("USERQUERY_uid");
    } catch (err) {
      console.warn("[USERQUERY] localStorage not available. Using in-memory ID.");
    }
    if (!existingId) {
      if (crypto && typeof crypto.randomUUID === "function") {
        existingId = crypto.randomUUID();
      } else {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        const hex = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
        existingId = `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
      }
      try {
        localStorage.setItem("USERQUERY_uid", existingId);
      } catch (err) {
        console.warn("[USERQUERY] Unable to persist userId to localStorage.");
      }
    }
    return existingId;
  }

  /**
   * Add an event to the batch with enriched data.
   */
  function trackInternal(eventName, data = {}) {
    const payload = {
      eventName,
      timestamp: new Date().toISOString(),
      siteId: _siteId,
      userId: _userId,
      url: window.location.href,
      userAgent: navigator.userAgent,
      screenSize: window.screen.width + "x" + window.screen.height,
      language: navigator.language,
      referrer: document.referrer,
      ...data
    };
    _eventBatch.push(payload);
  }

  /**
   * Broadcast the batched events via a POST request using fetch.
   */
  function flushEventBatch() {
    if (_eventBatch.length === 0) return;
    const eventsPayload = {
      userId: _userId,
      siteId: _siteId,
      events: _eventBatch,
    };
    const payloadString = JSON.stringify(eventsPayload);

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadString,
    })
      .then((response) => {
        if (!response.ok) {
          console.warn("[USERQUERY] Failed to post events. Response status:", response.status);
        } else {
          console.log("[USERQUERY] Events posted successfully. Response status:", response.status);
        }
        _eventBatch = [];
      })
      .catch((err) => {
        console.warn("[USERQUERY] Error posting events:", err);
        _eventBatch = [];
      });
  }

  /**
   * Attach core event listeners to collect as much data as possible.
   */
  function attachCoreEventListeners() {
    // 1. Click events: Label element and capture click details.
    const clickHandler = function (e) {
      labelElement(e.target);
      trackInternal("click", {
        tagName: e.target.tagName,
        dataZenId: e.target.getAttribute("data-zenid"),
        id: e.target.id || null,
        classes: e.target.className || null,
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY
      });
    };
    document.addEventListener("click", clickHandler);
    _eventListeners.push({ target: document, event: "click", handler: clickHandler });

    // 2. Page load: Capture page title and performance timing.
    const pageLoadHandler = function () {
      let loadTime = "";
      if (window.performance) {
        const navEntries = performance.getEntriesByType("navigation");
        if (navEntries && navEntries.length > 0) {
          loadTime = navEntries[0].loadEventEnd - navEntries[0].startTime;
        } else if (performance.timing) {
          loadTime = performance.timing.loadEventEnd - performance.timing.navigationStart;
        }
      }
      trackInternal("pageLoad", {
        title: document.title,
        loadTime: loadTime
      });
    };
    window.addEventListener("load", pageLoadHandler);
    _eventListeners.push({ target: window, event: "load", handler: pageLoadHandler });

    // 3. Page unload: Log unload event and flush the batch.
    const unloadHandler = function () {
      trackInternal("pageUnload");
      flushEventBatch();
    };
    window.addEventListener("beforeunload", unloadHandler, { capture: true });
    _eventListeners.push({ target: window, event: "beforeunload", handler: unloadHandler, options: { capture: true } });

    // 4. Scroll events: Throttle to once per second.
    let lastScrollTime = 0;
    const scrollHandler = function () {
      const now = Date.now();
      if (now - lastScrollTime < 1000) return;
      lastScrollTime = now;
      const scrollDepth = window.scrollY + window.innerHeight;
      const pageHeight = document.documentElement.scrollHeight;
      const scrollPercent = Math.round((scrollDepth / pageHeight) * 100);
      trackInternal("scroll", { scrollDepth, scrollPercent });
    };
    window.addEventListener("scroll", scrollHandler);
    _eventListeners.push({ target: window, event: "scroll", handler: scrollHandler });

    // 5. Resize events: Capture window size changes.
    const resizeHandler = function () {
      trackInternal("resize", {
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        screenSize: window.screen.width + "x" + window.screen.height
      });
    };
    window.addEventListener("resize", resizeHandler);
    _eventListeners.push({ target: window, event: "resize", handler: resizeHandler });

    // 6. Visibility changes: Capture when the document visibility changes.
    let previousVisibilityState = document.visibilityState;
    const visibilityHandler = function () {
      const currentVisibilityState = document.visibilityState;
      if (previousVisibilityState !== currentVisibilityState) {
        if (currentVisibilityState === "hidden") {
          trackInternal("visibility change away");
        } else if (currentVisibilityState === "visible") {
          trackInternal("visibility change to");
        }
      }
      previousVisibilityState = currentVisibilityState;
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    _eventListeners.push({ target: document, event: "visibilitychange", handler: visibilityHandler });

    // 7. Error tracking: Capture runtime errors.
    const errorHandler = function (message, source, lineno, colno, error) {
      trackInternal("error", {
        message,
        source,
        lineno,
        colno,
        error: error ? error.toString() : ""
      });
    };
    window.addEventListener("error", errorHandler);
    _eventListeners.push({ target: window, event: "error", handler: errorHandler });
  }

  /**
   * Initialize USERQUERY with the provided configuration.
   */
  USERQUERY.init = function (config = {}) {
    if (_initialized) {
      console.warn("[USERQUERY] Already initialized.");
      return;
    }
    _initialized = true;
    _config = Object.assign({}, DEFAULT_CONFIG, config);
    _siteId = _config.siteId;
    _userId = getOrCreateUserId();

    console.log(`[USERQUERY] Initializing with siteId="${_siteId}", userId="${_userId}"`);

    // Attach event listeners.
    attachCoreEventListeners();

    // If the document is already fully loaded, immediately track a page load.
    if (document.readyState === "complete") {
      trackInternal("pageLoad", { title: document.title });
    }

    // Set up periodic flush of the event batch.
    _batchTimer = setInterval(flushEventBatch, _config.batchInterval);
  };

  /**
   * Stop USERQUERY by removing event listeners and flushing pending events.
   */
  USERQUERY.stop = function () {
    if (!_initialized) {
      console.warn("[USERQUERY] Not initialized or already stopped.");
      return;
    }
    _initialized = false;
    console.log("[USERQUERY] Stopping. Removing event listeners...");

    _eventListeners.forEach(({ target, event, handler, options }) => {
      target.removeEventListener(event, handler, options || false);
    });
    _eventListeners = [];

    flushEventBatch();

    if (_batchTimer) {
      clearInterval(_batchTimer);
      _batchTimer = null;
    }
  };

  /**
   * Log a custom event with a given name and data payload.
   */
  USERQUERY.trackCustom = function (eventName, data = {}) {
    if (!_initialized) {
      console.warn("[USERQUERY] Not initialized. Cannot track custom events.");
      return;
    }
    trackInternal(eventName, data);
  };

  // Expose USERQUERY globally.
  global.USERQUERY = USERQUERY;
})(window);
