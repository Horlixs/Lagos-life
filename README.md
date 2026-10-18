# Horlixs 🔥 - Lagos Life Swarm Funding Portal

A high-performance Next.js application that coordinates autonomous bot swarms to disburse funds to verified players on **Lagos Life** with anti-cheat tolerance and intelligent rate-limit mitigation.

## Features

- **Anti-Cheat Safe Chunking**: Dynamically partitions high-value funding requests into safe sub-deltas ($\le$ ₦15M) to prevent triggering server-side refusal thresholds.
- **2,700+ Swarm Bot Pool**: Rotates across a wide pool of authenticated accounts with cooldown tracking and failure recovery.
- **Real-Time Telemetry**: Live order tracking, batch status indicators, and mobile-responsive administration dashboard.
- **Multi-Store Support**: Dual-mode data persistence featuring automatic failover between MongoDB Atlas and local disk storage.

## Getting Started

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run locally**:
   ```bash
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000) to view the portal.

## Admin Dashboard

Access the Command Dashboard at `/admin` to monitor telemetry, review user distributions, manage IP blocks, and control the global kill switch.
