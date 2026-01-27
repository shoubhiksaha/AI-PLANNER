# AI Planner - Zero Storage Architecture 🚀

**A privacy-focused PWA that digitizes handwritten planner pages using Google Gemini 2.0 Flash.**

[![Watch Demo](https://img.shields.io/badge/Demo-Watch%20Video-red)](https://youtu.be/GfeUy8J7WFc)
[![Live App](https://img.shields.io/badge/Live-Try%20Beta-blue)](https://ai-planner-project-467800.web.app)

> [!NOTE]  
> **Testing Mode Restriction**: Since this project is in Google Cloud "Testing Mode," new users need to be white-listed to log in.  
> **To get access**: Email [officialshoubhiksaha@gmail.com](mailto:officialshoubhiksaha@gmail.com) with the subject "Beta Access". I usually approve within 1 hour.

![Status](https://img.shields.io/badge/Status-Production-success)
![Privacy](https://img.shields.io/badge/Privacy-Zero%20Storage-green)
![Tech](https://img.shields.io/badge/Stack-Firebase%20%7C%20Node.js%20%7C%20Gemini-blue)

## 📖 The "Zero Storage" Philosophy
Unlike traditional apps that store user images in an S3 bucket or database, **AI Planner** operates on a strict **Zero Storage** architecture.
*   User images are processed **in-memory** (Transient RAM).
*   Data is extracted by Gemini AI and synced to Google/Notion APIs.
*   The original image buffer is wiped immediately after processing.
*   **Result**: Verifyable privacy. We cannot see your journal even if we wanted to.

---

## 📈 Project Evolution: A Journey of Iteration

This project is not just a static codebase; it is the result of continuous product iteration and architectural refinement.

### V1: The MVP (Calendar Only)
*   **Scope**: Basic image upload to sync handwritten events to Google Calendar.
*   **Architecture**: Simple Firebase Trigger.

### V2: Feature Expansion & Stabilization
*   **New Features**: Added Evening Sync (Task Completion), Expenses, Health, and Journaling.
*   **Challenges**: Initial "Task Completion" logic was buggy due to fuzzy matching; refined to be exact.
*   **Growth**: Moved from a simple script to a multi-service function.

### V3: Refinement & Zero Storage (Current)
*   **Goal**: 100% Privacy & Cost Reduction.
*   **Architecture**: Implemented **Zero Storage** (RAM-only processing).
*   **Engineering**: Modularized AI logic to easily swap providers (Gemini 2.0). 
*   **Notion**: Implemented **Custom Direct File Upload Protocol** (bypassing SDK limits for binary streams).

### V4: Future Roadmap
*   **BYOK**: "Bring Your Own Key" support for users.
*   **Multi-Provider**: Driver-based architecture to support OpenAI, Anthropic, or DeepSeek or any other provider.

---

## 🛠️ Technical Case Study: Engineering Challenges

This project evolved through several iterations to achieve its rigorous privacy goals. Below is a log of the key engineering challenges and solutions.

### 1. The "Transient Memory" Challenge
**Problem**: Most standard libraries for Firebase (`firebase-admin`) assume you want to upload files to a Storage Bucket.
**Solution**: We bypassed the standard Storage SDK entirely.
*   **Implementation**: Used `Buffer.from(base64)` to handle image streams directly in Node.js memory.
*   **Result**: Removed the `admin.storage()` dependency for the core AI pipeline.

### 2. Notion API Integration (The "401" Hurdle)
**Problem**: We needed to upload images to Notion *without* hosting them ourselves. The Notion API documentation for `file_uploads` is complex and often requires a 2-step process.
*   *Attempt 1*: Direct JSON upload (Failed - 400 Bad Request).
*   *Attempt 2*: using `client.auth` object (Failed - 401 Unauthorized).
**Solution**: Implemented the **Multi-Step Direct File Upload Protocol**.
*   **Step 1**: Initialize upload with JSON payload (`filename`, `content_type`). Receive `upload_url`.
*   **Step 2**: PUT binary data to `upload_url` using `FormData` and explicit `Authorization` headers.
*   **Step 3**: Link the resulting `file_id` to the Page Block.

### 3. Data Corruption (The "Static Noise" Bug)
**Problem**: Images appearing in Notion were corrupted (static noise/unreadable).
**Root Cause**: The raw Base64 string from the frontend included the Data URI header (`data:image/jpeg;base64,...`). When converted to a Buffer directly, this header corrupted the binary JPEG magic bytes.
**Solution**: Implemented a robust regex stripper before buffer creation:
```javascript
const mimeType = imageData.match(/data:(.*);base64,/)?.[1] || 'image/jpeg';
const base64Data = imageData.split(',')[1]; // Strip header
const buffer = Buffer.from(base64Data, 'base64');
```

---

## 🏗️ Architecture

See [Architecture Diagram](architecture.md).

**Stack**:
*   **Frontend**: Vanilla JS + TailwindCSS (PWA)
*   **Backend**: Firebase Functions (Node.js 20)
*   **AI**: Google Gemini 2.0 Flash (Multimodal)
*   **Auth**: Google Identity Services (OAuth 2.0)

---

## 🚀 How to Run

1.  **Clone**:
    ```bash
    git clone https://github.com/yourusername/ai-planner-zero.git
    ```
2.  **Install**:
    ```bash
    cd functions && npm install
    ```
3.  **Deploy**:
    ```bash
    firebase deploy
    ```
