// testNotion.js
import { Client } from "@notionhq/client";
import dotenv from 'dotenv';
dotenv.config();

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

console.log("--- Notion Test Script Initialized ---");
if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    console.error("Error: Missing NOTION_API_KEY or NOTION_DATABASE_ID in .env file.");
    process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

(async () => {
  console.log("Attempting to create a test page in Notion...");
  try {
    const response = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        // IMPORTANT: Make sure the property "Name" matches the title property of your database.
        "Name": {
          title: [{ text: { content: "API Connection Test Page" } }]
        }
      }
    });
    console.log("✅ Success! Page was created successfully.");
    console.log("View it here:", response.url);
  } catch (error) {
    // We expect this to fail with the same error.
    console.error("❌ Failure! The Notion API returned an error:", error.body);
  }
})();