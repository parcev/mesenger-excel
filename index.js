const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// Vartotojų būsenų atmintis
const userSessions = {};

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

async function sendMessage(senderId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: senderId }, message: { text } }
    );
  } catch (err) {
    console.error("Klaida siunčiant žinutę:", err.response?.data || err.message);
  }
}

// Funkcija, patikrinanti, ar vartotojas nori praleisti klausimą
function isSkip(text) {
  const skipPhrases = ["nie", "nie wiem", "nwm"];
  return skipPhrases.includes(text.toLowerCase().trim());
}

// Facebook Webhook patikrinimas (Handshake)
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// Gautų žinučių apdorojimas
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry) {
      const webhook_event = entry.messaging[0];
      if (!webhook_event || !webhook_event.message) continue;

      const senderId = webhook_event.sender.id;
      const text = webhook_event.message.text?.trim();

      if (!text) continue;

      // Komandos pradžia: "Add ..."
      if (text.toLowerCase().startsWith("add ")) {
        const itemTitle = text.substring(4).trim();
        userSessions[senderId] = { step: "PRICE", data: { name: itemTitle } };
        await sendMessage(senderId, `Pridedama: "${itemTitle}". Kokia kaina už vienetą?`);
        continue;
      }

      const session = userSessions[senderId];
      if (!session) {
        await sendMessage(senderId, "Parašykite 'Add [Pavadinimas]', kad pradėtumėte naujo daikto įvedimą.");
        continue;
      }

      const skipped = isSkip(text);

      // Nuoseklūs klausimai
      switch (session.step) {
        case "PRICE":
          session.data.price = skipped ? 0 : (parseFloat(text.replace(",", ".")) || 0);
          session.step = "QUANTITY";
          await sendMessage(senderId, "Koks kiekis?");
          break;

        case "QUANTITY":
          session.data.quantity = skipped ? 0 : (parseInt(text) || 1);
          session.step = "CATEGORY";
          await sendMessage(senderId, "Pasirinkite kategoriją: Robot ar Marketing");
          break;

        case "CATEGORY":
          if (skipped) {
            session.data.category = "";
          } else if (!["Robot", "Marketing"].includes(text)) {
            await sendMessage(senderId, "Netinkama kategorija! Galima rinktis tik: Robot arba Marketing (arba 'Nie' praleidimui)");
            return;
          } else {
            session.data.category = text;
          }
          session.step = "STATUS";
          await sendMessage(senderId, "Pasirinkite statusą: Bardzo treba / Trzeba / Zakazano / Mami");
          break;

        case "STATUS":
          if (skipped) {
            session.data.status = "";
          } else if (!["Bardzo treba", "Trzeba", "Zakazano", "Mami"].includes(text)) {
            await sendMessage(senderId, "Netinkamas statusas! Galima rinktis tik: Bardzo treba, Trzeba, Zakazano arba Mami (arba 'Nie' praleidimui)");
            return;
          } else {
            session.data.status = text;
          }
          session.step = "URL";
          await sendMessage(senderId, "Atsiųskite nuorodą (sylka):");
          break;

        case "URL":
          session.data.url = skipped ? "" : text;
          await sendMessage(senderId, "Saugoma į Excel...");
          try {
            await axios.post(MAKE_WEBHOOK_URL, session.data);
            await sendMessage(senderId, "✅ Sėkmingai pridėta į Excel lentelę!");
          } catch (err) {
            console.error("Klaida siunčiant į Make.com:", err.message);
            await sendMessage(senderId, "❌ Įvyko klaida įrašant į lentelę.");
          }
          delete userSessions[senderId];
          break;
      }
    }
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Botas veikia!"));