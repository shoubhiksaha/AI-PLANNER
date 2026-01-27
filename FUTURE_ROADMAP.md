# AI Planner: Future Roadmap & Engineering Strategy 🚀

This document outlines the strategic pivot from a "Pipeline Tool" to a true "AI Agent," focusing on engineering rigor, resiliency, and product psychology.

## 1. The "Agentic" Pivot (Product Evolution)
*To survive the AI era, the app must actively collaborate with the user, not just process data.*

### A. Clarification Loops (Human-in-the-Loop)
*   **Concept**: Instead of failing silently or guessing, the AI asks for clarification.
*   **Example**: "Hey, this meeting note has no date. Should I schedule it for tomorrow?"
*   **Tech**: Requires WebSocket/Push Notifications to handle async user feedback.

### B. The "Smart Rollover" (Morning Migration)
*   **Problem**: Users feel guilty about unfinished tasks.
*   **Feature**: When scanning a new page, the AI identifies yesterday's unfinished tasks and asks: "You have 5 unfinished tasks. Which ones should I roll over to today?"
*   **Psychology**: Bridges the gap between yesterday's failure and today's fresh start.

### C. The "Cognitive Handshake" (Closure)
*   **Feature**: A specific sound or animation that triggers only when the "Brain Dump" is successfully captured.
*   **Psychology**: Signals to the brain that the "open loop" is closed, reducing anxiety and freeing up cognitive space for Deep Work.

---

## 2. Engineering Rigor (The Senior Engineer Pivot)
*Focusing on resilience and maintainability over feature count.*

### A. Resilience & Fallbacks
*   **Dead Letter Queue (DLQ)**: If the Notion API is down, save the sync payload to a persistent queue (Redis/Firestore) and retry later. Never drop user data.
*   **Notion Fallback**: If the custom "Binary Upload" (Reverse Engineered) fails, automatically fallback to the official (but slower) Notion API and alert the user.

### B. Observability
*   **Metrics**: Track "AI Latency" and "Token Usage per User" using OpenTelemetry or structured logging.
*   **Goal**: Reduce average costs by 20% through monitoring and optimization.

### C. Offline-First (PWA)
*   **Architecture**: Use IndexedDB to save notes locally when offline, then sync when connectivity is restored.

### D. Testing Strategy
*   **Unit Tests**: Write specific tests for the "In-Memory Buffer" logic to prove it handles memory leaks under load.
*   **Multipart Upload**: Test the reverse-engineered Notion logic against mocked endpoints to ensure stability.

---

## 3. Product Roadmap (V3 & V4)

### A. Brain Dump 2.0 (Searchable & Tagged)
*   **Background OCR**: Transcribe all handwritten notes in the background so users can search for "Revenue" and find the image.
*   **Smart "Librarian"**: Automatically tag dumps (e.g., `#Idea`, `#Anxiety`, `#Meeting`) to provide Notion-level organization without manual effort.

### B. BYOK (Bring Your Own Key)
*   **Architecture**: Allow users to input their own OpenAI/Anthropic keys.
*   **Security**: Requires AES-256 encryption for secure key storage. Moves the project from "Toy App" to "SaaS Architecture."

### C. Rate Limiting
*   **Backend Depth**: Implement queuing for heavy image processing to prevent server overload during spikes.

---

## 4. Interview Preparation: The "Why"
*To pass the "AI Did The Coding" text, you must understand the underlying decisions.*

*   **Why Gen 2 Cloud Functions?** -> Meaningful concurrency controls and Request/Response streamlining.
*   **Why Node.js Buffers?** -> To avoid the latency and cost of disk I/O (writing to temporary files).
*   **How do you handle memory leaks?** -> content-length checks and strict buffer garbage collection (transient processing).
