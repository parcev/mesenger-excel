const express = require("express");
const axios = require("axios");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

// In-memory conversation state management
const userSessions = {};

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
    await page.goto(MS_FORM_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    logStep("PLAYWRIGHT_WAIT", "Waiting for input text fields to render...");
    const inputSelector = 'input[type="text"]';
    await page.waitForSelector(inputSelector, { state: "visible", timeout: 15000 });

    const inputs = page.locator(inputSelector);
    const count = await inputs.count();
    logStep("PLAYWRIGHT_VERIFY", `Found ${count} text input fields on page.`);

    if (count < 6) {
      throw new Error(`Form mismatch! Expected at least 6 fields, found ${count}.`);
    }

    logStep("PLAYWRIGHT_FILL", `[1/6] Setting Name: "${data.name}"`);
    await inputs.nth(0).fill(data.name);

    logStep("PLAYWRIGHT_FILL", `[2/6] Setting Price: "${data.price}"`);
    await inputs.nth(1).fill(data.price.toString());

    logStep("PLAYWRIGHT_FILL", `[3/6] Setting Quantity: "${data.quantity}"`);
    await inputs.nth(2).fill(data.quantity.toString());

    logStep("PLAYWRIGHT_FILL", `[4/6] Setting Category: "${data.category}"`);
    await inputs.nth(3).fill(data.category);

    logStep("PLAYWRIGHT_FILL", `[5/6] Setting Status: "${data.status}"`);
    await inputs.nth(4).fill(data.status);

    logStep("PLAYWRIGHT_FILL", `[6/6] Setting URL: "${data.url}"`);
    await inputs.nth(5).fill(data.url);

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
    if (browser) {
      try {
        const pages = browser.contexts()[0]?.pages();
        if (pages && pages.length > 0) {
          logStep("PLAYWRIGHT_DIAGNOSTIC", `Page title: "${await pages[0].title()}" | Current URL: ${pages[0].url()}`);
        }
      } catch (diagErr) {
        logStep("PLAYWRIGHT_DIAGNOSTIC_ERR", `Could not read state: ${diagErr.message}`);
      }
    }
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
      
      // Captures text whether typed manually or clicked via Quick Reply payload
      const text = (webhook_event.message.quick_reply?.payload || webhook_event.message.text)?.trim();

      if (!text) continue;

      logStep("MSG_IN", `From Sender [${senderId}]: "${text}"`);

      // Case-insensitive trigger: "add ", "ADD ", "Add "
      if (text.toLowerCase().startsWith("add ")) {
        const itemTitle = text.substring(4).trim();
        userSessions[senderId] = { step: "PRICE", data: { name: itemTitle } };
        logStep("SESSION", `Started entry for "${itemTitle}" [User: ${senderId}]`);
        await sendMessage(senderId, `Pridedama: "${itemTitle}". Kokia kaina už vienetą?`);
        continue;
      }

      const session = userSessions[senderId];
      if (!session) {
        await sendMessage(senderId, "Parašykite 'Add [Pavadinimas]', kad pradėtumėte naujo daikto įvedimą.");
        continue;
      }

      // Step-by-step state machine
      switch (session.step) {
        case "PRICE":
          session.data.price = parseFloat(text.replace(",", ".")) || 0;
          session.step = "QUANTITY";
          logStep("SESSION", `User ${senderId} set price: ${session.data.price}`);
          await sendMessage(senderId, "Koks kiekis?");
          break;

        case "QUANTITY":
          session.data.quantity = parseInt(text) || 1;
          session.step = "CATEGORY";
          logStep("SESSION", `User ${senderId} set quantity: ${session.data.quantity}`);
          
          // Sends text with Quick Reply buttons for Category
          await sendMessage(
            senderId,
            "Pasirinkite kategoriją arba įrašykite:",
            ["Robot", "Marketing"]
          );
          break;

        case "CATEGORY": {
          const categories = {
            "robot": "Robot",
            "marketing": "Marketing"
          };
          const matchedCategory = categories[text.toLowerCase()];

          if (!matchedCategory) {
            await sendMessage(
              senderId,
              "Netinkama kategorija! Galima rinktis tik iš pateiktų mygtukų:",
              ["Robot", "Marketing"]
            );
            return;
          }

          session.data.category = matchedCategory;
          session.step = "STATUS";
          logStep("SESSION", `User ${senderId} set category: ${session.data.category}`);
          
          // Sends text with Quick Reply buttons for Status
          await sendMessage(
            senderId,
            "Pasirinkite statusą arba įrašykite:",
            ["Bardzo trzeba", "Trzeba", "Zakazano", "Mami"]
          );
          break;
        }

        case "STATUS": {
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
              "Netinkamas statusas! Galima rinktis tik iš pateiktų mygtukų:",
              ["Bardzo trzeba", "Trzeba", "Zakazano", "Mami"]
            );
            return;
          }

          session.data.status = matchedStatus;
          session.step = "URL";
          logStep("SESSION", `User ${senderId} set status: ${session.data.status}`);
          await sendMessage(senderId, "Atsiųskite nuorodą (sylka):");
          break;
        }

        case "URL":
          session.data.url = text;
          logStep("SESSION", `User ${senderId} set URL: ${session.data.url}. Submitting form...`);
          await sendMessage(senderId, "⏳ Saugoma į Excel lentelę...");
          
          try {
            await fillFormAndSubmit(session.data);
            await sendMessage(senderId, "✅ Sėkmingai pridėta į Excel lentelę!");
            logStep("COMPLETED", `Added item "${session.data.name}" for User ${senderId}`);
          } catch (err) {
            logStep("CRITICAL_ERR", `Failed to complete entry: ${err.message}`);
            await sendMessage(senderId, `❌ Klaida įrašant į lentelę: ${err.message.substring(0, 100)}`);
          }
          
          delete userSessions[senderId];
          break;
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logStep("SERVER", `Server listening on port ${PORT}`));
