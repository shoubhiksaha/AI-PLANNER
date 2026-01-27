# System Architecture: "Zero Storage" AI Planner

## Architectural Diagram
This diagram illustrates the flow of data where the image is processed entirely in-memory (Transient) without relying on persistent storage buckets, ensuring maximum privacy.

```mermaid
graph TD
    %% Nodes
    User(["User (PWA)"])
    subgraph "Backend (Firebase Functions)"
        SyncPlanner["syncPlanner Function<br/>(Node.js 20 Setup)"]
        MemoryBuffer["In-Memory Buffer<br/>(Transient Image Data)"]
    end
    
    subgraph "AI Analysis"
        Gemini["Gemini 2.0 Flash<br/>(Google AI Studio)"]
    end
    
    subgraph "External Integrations"
        GCal[Google Calendar/Tasks]
        GSheets[Google Sheets]
        NotionAPI["Notion API<br/>(File Uploads)"]
        NotionS3[Notion Internal Storage]
    end

    %% Flow
    User -->|POST /syncPlanner<br/>(Base64 Image)| SyncPlanner
    SyncPlanner -->|1. Decode & Strip Prefix| MemoryBuffer
    
    MemoryBuffer -->|2. Stream Image (Inline)| Gemini
    Gemini -->|3. Return JSON Data| SyncPlanner
    
    SyncPlanner -->|4. Sync Events| GCal
    SyncPlanner -->|5. Sync Expenses| GSheets
    
    %% Notion Flow (Complex)
    SyncPlanner -- "6a. Init Upload (JSON)" --> NotionAPI
    NotionAPI -- "6b. Get Upload URL" --> SyncPlanner
    MemoryBuffer -- "6c. Stream Binary (FormData)" --> NotionAPI
    NotionAPI -- "6d. Store File" --> NotionS3
    NotionAPI -- "6e. Return File ID" --> SyncPlanner
    SyncPlanner -- "6f. Create Page + Attach ID" --> NotionAPI
    
    %% Styling
    style MemoryBuffer fill:#ffcccb,stroke:#a00,stroke-width:2px,stroke-dasharray: 5 5
    style Gemini fill:#e1f5fe,stroke:#01579b
    style SyncPlanner fill:#e8f5e9,stroke:#2e7d32
```
