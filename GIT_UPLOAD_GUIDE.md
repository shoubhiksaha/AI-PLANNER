# How to Upload to GitHub (Safely) 🛡️

I have already updated your `.gitignore` file to ensure **API Keys and Secrets are NOT uploaded**. The following files will stay on your computer only:
*   `.env` (Environment Variables)
*   `credentials.json` / `client_secret...json`
*   `functions/.env`

## Step 1: Create Repository

### Option A: Browser (Easiest)
1.  Go to [GitHub.com/new](https://github.com/new).
2.  Name it `ai-planner-zero`.
3.  **Do not** initialize with README.
4.  Copy the URL.

### Option B: Terminal Only (Pro Mode) 🛠️
If you want to stay in the terminal, you need the GitHub CLI.
```bash
# 1. Install GitHub CLI
brew install gh

# 2. Login (Follow the prompts)
gh auth login

# 3. Initialize Git
git init
git add .
git commit -m "Initial commit"

# 4. Create Repo (Public = Best for Portfolio)
gh repo create ai-planner-zero --public --source=. --remote=origin
```

*Note: We use `--public` so recruiters can see it. Your secrets are safe because of the .gitignore file.*

## Step 2: Push the Code
Open your terminal in VS Code and run these commands one by one:

```bash
# 1. Initialize Git (if not already done)
git init

# 2. Add all files (this respects the .gitignore rules)
git add .

# 3. Create the first commit
git commit -m "Initial commit: Zero Storage AI Planner V3"

# 4. Rename branch to main
git branch -M main

# 5. Link to your new GitHub Repo (REPLACE THE URL BELOW)
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git

# 6. Push code
git push -u origin main
```

## Step 3: Verify
Go to your GitHub page. You should see `README.md` and the code, but **NOT** `.env` or `credentials.json`.
