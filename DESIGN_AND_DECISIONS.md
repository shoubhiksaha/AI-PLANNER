# Design Decisions & Project Documentation

This document serves as a comprehensive record of the thought processes, architectural choices, and design philosophy behind the AI Planner project. It encapsulates the evolution of the project from initial concepts to the current implementation.

## 1. Core Philosophy: "Zero Storage" Architecture

### **Decision**
The project explicitly avoids storing user data (images, analyzed text, planner contents) in its own persistent database wherever possible.

### **Rationale**
-   **Privacy First**: By not storing personal journal entries or planner images, we minimize data liability and increase user trust. Data flows *through* our server, not *into* it.
-   **Cost Efficiency**: Reduces storage costs on Firebase. We only use transient memory during the function execution.
-   **Simplicity**: Simplifies GDPR/CCPA compliance as we are processors, not data controllers for the long term.

### **Implementation Details**
-   Images are received via HTTP, held in memory (RAM), processed by AI, sent to external services (Notion/Google), and then immediately discarded when the function finishes.
-   We use `firebase-functions` with increased memory (1GiB) to handle these transient heavy payloads without writing to disk.

---

## 2. Serverless Backend (Firebase Functions)

### **Decision**
The backend logic is hosted on Firebase Cloud Functions (Gen 2).

### **Rationale**
-   **Scalability**: Automatically scales down to zero when not in use (cost-saving) and scales up during morning/evening bursts.
-   **Integration**: Native integration with Firebase Admin (for basic user config) and Google Cloud APIs.

### **Key Optimizations**
-   **Lazy Loading**: Modules like `googleapis`, `@notionhq/client`, and `@google/generative-ai` are required *inside* the function scope. This drastically reduces "Cold Start" times by only loading heavy libraries when they are actually needed.
-   **Custom Timeout**: Set to 300 seconds (5 minutes) because AI processing and multi-service syncing can be slow.
-   **Manual CORS Handling**: We implement custom CORS logic to handle `OPTIONS` pre-flight requests to ensure smooth communication with the frontend from any origin.

---

## 3. AI Integration (Google Gemini)

### **Decision**
We use Google's Gemini models (`gemini-2.0-flash`, `gemini-1.5-flash`) for handwriting recognition and data extraction.

### **Rationale**
-   **Multimodal Capabilities**: Gemini natively understands images and text, making it ideal for reading handwritten planners.
-   **Cost/Performance**: The "Flash" series models offer an excellent balance of speed and cost for this specific use case.

### **Resilience & Reliability**
-   **Retry Logic with Exponential Backoff**: The system expects API rate limits (HTTP 429). It implements a smart retry loop that waits longer between each failed attempt (1s, 2s, 4s...) to handle traffic spikes gracefully.
-   **Model Fallback Strategy**: We define a priority list of models (`flash-lite` -> `flash` -> `latest`). If the primary model fails or times out, the system automatically tries the next one in the list.
-   **JSON Enforcement**: We explicitly request `responseMimeType: "application/json"` to ensure the AI returns structured data that code can parse reliably.

---

## 4. Performance & Parallelism

### **Decision**
Process independent tasks concurrently rather than sequentially.

### **Rationale**
Sequential processing (Do A, then B, then C) is too slow for a user waiting for a response.

### **Implementation**
-   **`Promise.all` Pattern**:
    -   *Morning Routine*: We sync Google Calendar Events AND Google Tasks simultaneously.
    -   *Evening Routine*: We sync Google Sheets (Expenses/Health) AND Notion pages simultaneously.
    -   *Journaling*: We upload the image to Notion AND ask AI to extract the date at the same time.
-   This approach roughly equates to `Time = Max(Task_A, Task_B)` instead of `Time = Task_A + Task_B`.

---

## 5. Daily Workflows (Morning vs. Evening)

The application logic determines the workflow based on the `syncType` or time of day.

### **Morning Sync**
-   **Goal**: Prepare the user for the day.
-   **Actions**:
    1.  Parse schedule and To-Dos.
    2.  Create Calendar Events (with reminders).
    3.  Create Google Tasks (due today).
    *(Note: Morning sync does NOT mark tasks as complete, as users typically plan upcoming work).*

### **Evening Sync**
-   **Goal**: Review and log the day.
-   **Actions**:
    1.  Mark tasks as completed in Google Tasks based on checkmarks.
    2.  Parse expenses, health metrics, and brain dump.
    3.  Log financials to Google Sheets ("Expenses" tab).
    4.  Log health stats to Google Sheets ("Health" tab).
    5.  Upload the raw planner image + "Brain Dump" text to a Notion Page for archiving.

### **Journal Sync**
-   **Goal**: Digital backup of physical journal.
-   **Actions**:
    1.  Upload high-res image to Notion (bypassing AI limits if needed).
    2.  Extract date via AI to name the entry correctly.

---

## 6. External Integrations

### **Google Ecosystem**
-   **Calendar**: Adds blocks (events) and reminders. Handles time zones (`Asia/Kolkata` default).
-   **Tasks**: Syncs actionable items. Supports "checking off" tasks (two-way sync simulation).
-   **Sheets**: Used as a structured database for quantitative data (Money, Health stats).

### **Notion**
-   **Protocol**: Uses the Notion API to create pages and append blocks.
-   **Image Upload**: Implements the specific two-step Notion file upload process (Get URL -> Upload Binary) to host images directly on Notion, adhering to the Zero Storage policy.

---

## 7. Frontend & UI (Context from History)

### **Design Language**
-   **Glassmorphism**: The UI aims for a modern, transparent "glass" aesthetic (referenced in previous "Refining Glass Transparency" tasks).
-   **Tailwind CSS**: Used for rapid, utility-first styling.
-   **Simplicity**: The user interface focuses on a single primary action—uploading the daily planner image—keeping friction to a minimum.

---

## 8. Security Measures

-   **Environment Variables**: API keys (Gemini) are stored in Firebase Params, not in the code.
-   **Payload Validation**:
    -   Strict checks for OAuth tokens.
    -   Image size limits (~20MB) to prevent memory exhaustion attacks.
-   **Error Masking**: The backend logs full stack traces for developers but sends generic, safe error messages ("Internal Server Error") to the client.
