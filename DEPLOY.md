# Deploying SheinBot to AWS

You can deploy this bot to AWS in two ways: using **Docker** (Recommended) or mostly manually on an **EC2** instance.

## Prerequisites
- An AWS Account.
- Your `BOT_TOKEN` from BotFather.

---

## Option 1: Docker (Easiest)
This method works on any server with Docker installed (EC2, DigitalOcean, etc.).

1.  **Install Docker** on your server.
2.  **Upload the code** to your server.
3.  **Build the image**:
    ```bash
    docker build -t sheinbot .
    ```
4.  **Run the container**:
    ```bash
    docker run -d \
      --name sheinbot \
      --restart unless-stopped \
      -e BOT_TOKEN="YOUR_ACTUAL_BOT_TOKEN" \
      -e HEADLESS=true \
      -v $(pwd)/chrome_profile:/usr/src/app/chrome_profile \
      sheinbot
    ```
    *Note: The `-v` flag mounts the session directory so login cookies persist if the container restarts.*

---

## Option 2: AWS EC2 (Manual Node.js)
If you prefer running directly on a VM (Ubuntu 22.04 recommended).

1.  **Launch an EC2 Instance** (t3.small or larger recommended for Puppeteer).
2.  **Connect via SSH**.
3.  **Install Node.js 18+**:
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
4.  **Install Chrome Dependencies**:
    Puppeteer requires system libraries on Linux.
    ```bash
    sudo apt-get install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils
    ```
5.  **Clone/Upload Code**:
    Copy your bot files to a folder (e.g., `~/sheinbot`).
6.  **Install Dependencies**:
    ```bash
    cd ~/sheinbot
    npm install
    ```
7.  **Setup Environment**:
    Create a `.env` file:
    ```bash
    nano .env
    ```
    Paste your config:
    ```
    BOT_TOKEN=your_token_here
    HEADLESS=true
    ```
8.  **Run with PM2** (to keep it alive):
    ```bash
    sudo npm install -g pm2
    pm2 start index.js --name sheinbot
    pm2 save
    pm2 startup
    ```

## Important Notes for AWS
- **Session Persistence**: Since `chrome_profile` saves your login, keeping it persistent is key. In Docker, use volumes (as shown). In EC2, standard file storage is fine.
- **Headless Mode**: Always set `HEADLESS=true` on servers. Code has been updated to respect this.
- **Login**: Since the server is headless, you cannot log in interactively.
    - **Method A**: Run the bot locally first, log in, then **copy the `chrome_profile` folder** to your server.
    - **Method B**: Use the `/start` login flow if we implemented QR/Code login (currently manual login requires GUI). **Recommendation: Method A**.
