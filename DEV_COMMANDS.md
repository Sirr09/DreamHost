# Development Commands

Use this while editing the project:

```bash
npm run dev
```

Open the site at:

```text
http://localhost:5173
```

The frontend will refresh when files in `client/src` change. The backend API runs on `http://localhost:5000` and Vite proxies `/api` automatically.

Use this before uploading to hosting:

```bash
npm run build
npm run start
```

`npm run build` writes the production frontend into `server/public`. If you only open `http://localhost:5000`, you are looking at the last built production copy, so source changes will appear there only after a new build.
