# Publishing VoxyDB to GitHub

The project source is maintained in this repository:

- Repository: https://github.com/kritikakumari0972-bit/voxy-db
- Default branch: `main`
- Current release baseline: `v0.5.1`

Clone and work on the project with:

```bash
git clone https://github.com/kritikakumari0972-bit/voxy-db.git
cd voxy-db
npm install
npm test
```

The API-key prefix remains `ndb_live_` for compatibility with credentials created by the original NovaDB release. The SDK also keeps `NovaDB` and `NovaDBError` export aliases; new projects should use `VoxyDB` and `VoxyDBError` from `/voxydb.js`.
