# Security

## Reporting a problem

If you find a security issue in ZeroPlayer, please **do not open a public issue**. Use GitHub's
"Report a vulnerability" button in the *Security* tab of this repository, and we will get back to you.

## How updates are protected

- Updates are only downloaded over HTTPS from GitHub.
- The downloaded file is checked against the SHA-256 digest that GitHub publishes for it.
- **Android:** before installing, the app checks that the APK is ZeroPlayer, is newer, and is signed with the
  same key as the installed app. Android itself also refuses updates signed with a different key.
- **Windows:** the installer is saved to a private temporary folder and checked before it runs.
- Release builds are signed in GitHub Actions with a key kept in encrypted secrets, never in the source code.

## Privacy

ZeroPlayer has no accounts, ads or tracking. It only contacts these services when you use the matching feature:
GitHub (updates), LRCLIB (lyrics), SponsorBlock (segments of YouTube videos), AudD (song recognition),
alphacephei.com (offline voice model, downloaded once) and the websites you open links from.
