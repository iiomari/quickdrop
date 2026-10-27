# QuickDrop

A web-based AirDrop. Send photos, videos, files and text between an iPhone and a PC straight from the browser, with no app and no account.

**Live:** https://quickdrop-app.vercel.app

## How it works
1. Open the site on your computer. It shows a QR code and a 6-character code.
2. Scan the QR code with your iPhone camera, or type the code on the other device.
3. The two devices connect directly. Pick files or type text and send, in either direction.

- Peer-to-peer over WebRTC: files never pass through a server, and there's no size limit.
- Files arrive in their original quality, byte for byte.
- The only server involved is the free PeerJS server, used just to introduce the two devices (signaling).

> On iPhone, keep the page open and the screen on while sending. Safari drops the connection when the screen locks.
>
> To send videos and photos in their original format (HEVC/HEIC), choose them from the Files app rather than the Photos library, which may convert them.

## Tech
- Static site: `index.html`, `style.css`, `app.js`. No build step, no framework.
- [PeerJS](https://peerjs.com) for WebRTC signaling, [qrcodejs](https://github.com/davidshimjs/qrcodejs) for the QR code.
- Arabic (RTL) interface in a native iOS style, with dark mode and Dynamic Type.

## Run locally
```bash
python -m http.server 5173
```
Then open http://localhost:5173

## Deploy
```bash
vercel --prod
```

---

# QuickDrop (عربي)

موقع يشتغل مثل AirDrop: تنقل فيه الصور والفيديوهات والملفات والنصوص بين الآيفون والكمبيوتر من المتصفح مباشرة، بدون تطبيق وبدون حساب.

تمسح الـ QR من الكمبيوتر بكاميرا الآيفون، ويتصل الجهازين ببعض مباشرة عبر WebRTC. الملفات ما تمر على أي سيرفر، وما لها حد حجم، وتوصل بجودتها الأصلية.

Made by Omar · [LinkedIn](https://www.linkedin.com/in/omar-salharbi/)
