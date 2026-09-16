const express = require("express");
const axios = require("axios");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

// In-memory session store
const userSessions = {};

// 8 minutes in milliseconds
const INACTIVITY_TIMEOUT_MS = 8 * 60 * 1000;

// Keywords that allow skipping any question
const SKIP_WORDS = ["nie", "nwm", "niwiem", "nie wiem", "ni wiem", "hz", "idk", "xz"];

function isSkipInput(text) {
  return SKIP_WORDS.includes(text.toLowerCase());
}

// Validation Helper Functions
function isValidPositiveNumber(input) {
  const sanitized = input.replace(",", ".").trim();
  if (!/^\d+(\.\d+)?$/.test(sanitized)) return false;
  const num = parseFloat(sanitized);
  return !isNaN(num) && num > 0;
}

function isValidPositiveInteger(input) {
  const sanitized = input.trim();
  return /^[1-9]\d*$/.test(sanitized);
}

// Environment Variables from Render Dashboard
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MS_FORM_URL = process.env.MS_FORM_URL;

// Structured Logger with ISO Timestamps
function logStep(step, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [BOT] [${step}] ${message}`);
}

// Send Facebook Messenger response message (supports optional Quick Reply buttons)
async function sendMessage(senderId, text, quickReplyButtons = null) {
  try {
    const messageData = { text };

    if (quickReplyButtons && Array.isArray(quickReplyButtons)) {
      messageData.quick_replies = quickReplyButtons.map((title) => ({
        content_type: "text",
        title: title,
        payload: title
      }));
    }

    await axios.post(
      `https://graph.facebook.com/v25.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderId },
        message: messageData
      }
    );
  } catch (err) {
    console.error("Klaida siunčiant žinutę:", err.response?.data || err.message);
  }
}

// Start or reset the 8-minute inactivity timer for a user session
function resetSessionTimer(senderId) {
  if (userSessions[senderId]?.timer) {
    clearTimeout(userSessions[senderId].timer);
  }

  userSessions[senderId].timer = setTimeout(async () => {
    const session = userSessions[senderId];
    if (!session) return;

    logStep("TIMEOUT", `8-minute inactivity limit reached for User [${senderId}]. Auto-submitting collected data...`);
    await sendMessage(senderId, "⏳ Ty hył za długo nieaktywny: sochraniejsta do excelu...");

    try {
      await fillFormAndSubmit(session.data);
      await sendMessage(senderId, "✅ Automatycznie sochraneno w excelu, bo TY był nie aktywny!");
      logStep("TIMEOUT_SUCCESS", `Auto-submitted partial entry "${session.data.name}" for User ${senderId}`);
    } catch (err) {
      logStep("TIMEOUT_ERR", `Failed auto-submit on timeout: ${err.message}`);
      await sendMessage(senderId, `❌ oszybka zapisując do excelu: ${err.message.substring(0, 100)}`);
    }

    delete userSessions[senderId];
  }, INACTIVITY_TIMEOUT_MS);
}

// Playwright Browser Automation for Microsoft Forms
async function fillFormAndSubmit(data) {
  logStep("PLAYWRIGHT_INIT", "Launching headless Chromium browser...");
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    logStep("PLAYWRIGHT_NAVIGATE", `Loading form URL: ${MS_FORM_URL}`);
    // Wait until network traffic settles so dynamic scripts render fully
    await page.goto(MS_FORM_URL, { waitUntil: "networkidle", timeout: 30000 });

    logStep("PLAYWRIGHT_WAIT", "Waiting for text input fields to render...");
    
    // Microsoft Forms uses 'textbox' roles or specific automation IDs for input fields
    const inputs = page.getByRole("textbox");
    await inputs.first().waitFor({ state: "visible", timeout: 20000 });

    const count = await inputs.count();
    logStep("PLAYWRIGHT_VERIFY", `Found ${count} text input fields on page.`);

    if (count < 7) {
      throw new Error(`Form mismatch! Expected at least 7 fields, found ${count}.`);
    }

    logStep("PLAYWRIGHT_FILL", `[1/7] Setting Name: "${data.name || ""}"`);
    await inputs.nth(0).fill(data.name || "");

    logStep("PLAYWRIGHT_FILL", `[2/7] Setting Name: "${data.name || ""}"`);
    await inputs.nth(1).fill(data.name || "");

    logStep("PLAYWRIGHT_FILL", `[3/7] Setting Quantity: "${data.quantity || ""}"`);
    await inputs.nth(2).fill(data.quantity !== "" && data.quantity !== undefined ? String(data.quantity) : "");

    logStep("PLAYWRIGHT_FILL", `[4/7] Setting URL: "${data.url || ""}"`);
    await inputs.nth(3).fill(data.url !== "" && data.url !== undefined ? String(data.url) : "");

    logStep("PLAYWRIGHT_FILL", `[5/7] Setting Status: "${data.status || ""}"`);
    await inputs.nth(4).fill(data.status || "");

    logStep("PLAYWRIGHT_FILL", `[6/7] Setting Price: "${data.price || ""}"`);
    await inputs.nth(5).fill(data.price !== "" && data.price !== undefined ? String(data.price) : "");

    logStep("PLAYWRIGHT_FILL", `[7/7] Setting Category: "${data.category || ""}"`);
    await inputs.nth(6).fill(data.category || "");

    logStep("PLAYWRIGHT_SUBMIT", "Searching for submit button...");
    const submitBtn = page.locator('button[data-automation-id="submitButton"]');
    await submitBtn.waitFor({ state: "visible", timeout: 5000 });

    logStep("PLAYWRIGHT_SUBMIT", "Clicking submit button...");
    await submitBtn.click();

    logStep("PLAYWRIGHT_CONFIRM", "Waiting for post-submit processing...");
    await page.waitForTimeout(3000);

    logStep("PLAYWRIGHT_SUCCESS", "Form submitted successfully!");
    return true;

  } catch (err) {
    logStep("PLAYWRIGHT_ERROR", `Execution failed: ${err.message}`);
    throw err;
  } finally {
    if (browser) {
      logStep("PLAYWRIGHT_CLEANUP", "Closing Chromium browser process...");
      await browser.close();
    }
  }
}


// Facebook Webhook Handshake Verification
app.get("/webhook", (req, res) => {
  logStep("WEBHOOK_VERIFY", "Verification attempt received from Facebook.");
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    logStep("WEBHOOK_VERIFY", "Verification token matched successfully!");
    return res.send(req.query["hub.challenge"]);
  }
  logStep("WEBHOOK_VERIFY_ERR", "Verification token mismatch!");
  res.sendStatus(403);
});

// Facebook Webhook Message Receiver
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry) {
      const webhook_event = entry.messaging?.[0];
      if (!webhook_event || !webhook_event.message) continue;

      const senderId = webhook_event.sender.id;
      const text = (webhook_event.message.quick_reply?.payload || webhook_event.message.text)?.trim();

      if (!text) continue;

      logStep("MSG_IN", `From Sender [${senderId}]: "${text}"`);

      // Command trigger: "Add [Item Name]"
      if (text.toLowerCase().startsWith("add ") || text.toLowerCase().startsWith("dobaw ")) {
        if (userSessions[senderId]?.timer) {
          clearTimeout(userSessions[senderId].timer);
        }

        let itemTitle;
        if (text.toLowerCase().startsWith("add ")) {
          itemTitle = text.substring(4).trim();
        }
        else {
          itemTitle = text.substring(6).trim();
        }
        
        userSessions[senderId] = {
          step: "PRICE",
          data: { name: itemTitle, price: "", quantity: "", category: "", status: "", url: "" },
          timer: null
        };

        resetSessionTimer(senderId);
        logStep("SESSION", `Started entry for "${itemTitle}" [User: ${senderId}]`);
        await sendMessage(senderId, `Ok. Ile kosztuji?`);
        continue;
      }

      const session = userSessions[senderId];
      if (!session) {
        //await sendMessage(senderId, "Parašykite 'Add [Pavadinimas]', kad pradėtumėte naujo daikto įvedimą.");
        continue;
      }

      // Step-by-step state machine
      switch (session.step) {
        case "PRICE": {
          if (isSkipInput(text)) {
            session.data.price = "";
          } else if (isValidPositiveNumber(text)) {
            session.data.price = text.replace(",", ".").trim();
          } else {
            await sendMessage(
              senderId,
              "Nieprawidłowa cena!  Napisz cyfra (np. 50,67). Jeśli nie wiesz, pisz 'nie' albo 'nwm'"
            );
            return;
          }

          session.step = "QUANTITY";
          resetSessionTimer(senderId);

          logStep("SESSION", `User ${senderId} set price: ${session.data.price || "[SKIPPED]"}`);
          await sendMessage(senderId, "Skilki nada?");
          break;
        }

        case "QUANTITY": {
          if (isSkipInput(text)) {
            session.data.quantity = "";
          } else if (isValidPositiveInteger(text)) {
            session.data.quantity = text.trim();
          } else {
            await sendMessage(
              senderId,
              "Nieprawidłowa ilosc! Napisz cyfra. Jeżeli nie wiesz napisz 'nie' albo 'nwm'"
            );
            return;
          }

          session.step = "CATEGORY";
          resetSessionTimer(senderId);

          logStep("SESSION", `User ${senderId} set quantity: ${session.data.quantity || "[SKIPPED]"}`);
          await sendMessage(
            senderId,
            "Jaka kategorija:",
            ["Robot", "Marketing"]
          );
          break;
        }

        case "CATEGORY": {
          if (isSkipInput(text)) {
            session.data.category = "";
          } else {
            const categories = {
              "robot": "Robot",
              "marketing": "Marketing"
            };
            const matchedCategory = categories[text.toLowerCase()];

            if (!matchedCategory) {
              await sendMessage(
                senderId,
                "Niprawidlowa kategorija! Wybierz jakaš knopka. Jeżeli nie wiesz, napisz 'nie' albo 'xz'",
                ["Robot", "Marketing"]
              );
              return;
            }

            session.data.category = matchedCategory;
          }

          session.step = "STATUS";
          resetSessionTimer(senderId);

          logStep("SESSION", `User ${senderId} set category: ${session.data.category || "[SKIPPED]"}`);
          await sendMessage(
            senderId,
            "Wybierz status:",
            ["Bardzo trzeba", "Trzeba", "Zakazano", "Mami"]
          );
          break;
        }

        case "STATUS": {
          if (isSkipInput(text)) {
            session.data.status = "";
          } else {
            const statuses = {
              "bardzo trzeba": "Bardzo trzeba",
              "trzeba": "Trzeba",
              "zakazano": "Zakazano",
              "mami": "Mami"
            };
            const matchedStatus = statuses[text.toLowerCase()];

            if (!matchedStatus) {
              await sendMessage(
                senderId,
                "Nieprawidlowy status! Wybierz jakaś knopka.",
                ["Bardzo trzeba", "Trzeba", "Zakazano", "Mami"]
              );
              return;
            }

            session.data.status = matchedStatus;
          }

          session.step = "URL";
          resetSessionTimer(senderId);

          logStep("SESSION", `User ${senderId} set status: ${session.data.status || "[SKIPPED]"}`);
          await sendMessage(senderId, "Skiń sylka");
          break;
        }

        case "URL":
          if (session.timer) {
            clearTimeout(session.timer);
          }

          session.data.url = isSkipInput(text) ? "" : text;
          logStep("SESSION", `User ${senderId} set URL: ${session.data.url || "[SKIPPED]"}. Submitting form...`);
          await sendMessage(senderId, "⏳ Zapisuja do Excela...");
          
          try {
            await fillFormAndSubmit(session.data);
            await sendMessage(senderId, "✅ Udaczna zapisano do Excelu!");
            logStep("COMPLETED", `Added item "${session.data.name}" for User ${senderId}`);
          } catch (err) {
            logStep("CRITICAL_ERR", `Failed to complete entry: ${err.message}`);
            await sendMessage(senderId, `❌ oszybka zapisujac do excela (faTal ERROR!!!!!): ${err.message.substring(0, 100)}`);
          }
          
          delete userSessions[senderId];
          break;
      }
    }
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logStep("SERVER", `Server listening on port ${PORT}`));
