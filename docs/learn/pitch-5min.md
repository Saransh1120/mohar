# Mohar — 5 Minute Pitch (Hinglish)

Bolne ki speed: normal. Har section ka time diya hai. Total ~5 min.

---

## [0:00 – 0:45] Problem — hook

"Sir, ek sawaal se shuru karta hoon.

Jab bhi koi exam paper leak hota hai — aur India mein ye har saal hota hai — sabse pehle news mein kya aata hai? 'Investigation shuru.' Aur 6 mahine baad? Kuch nahi. Case band.

Kyun? Kyunki investigate karne ke liye jo record chahiye — kaun kab paper ke paas tha — wo record **hota hi nahi**. Register hota hai, lekin wo haath se, baad mein, jo convenient ho wo likh diya jaata hai.

Aur ek galatfehmi door kar doon: paper isliye leak nahi hote ki koi password crack karta hai. Wo isliye leak hote hain kyunki jo insaan paper ko hold karne ka **authorized** tha, usne aage de diya.

Hazaribagh case mein principal khud authorized tha strong room mein. Koi lock nahi toota. Bas record nahi tha."

---

## [0:45 – 1:15] Solution — one line

"To humara sawaal ye nahi hai ki 'leak kaise roke' — wo koi promise nahi kar sakta.

Humara sawaal ye hai: **jab leak ho, kya hum prove kar sakte hain ki har moment paper kiske paas tha? Aur kya wo proof un logo se bach sakta hai jo usko sabse zyada badalna chahenge?**

Mohar wahi karta hai. Paper ki journey ka har step ek signed record ban jaata hai, ek chain mein, jise baad mein koi edit ya delete nahi kar sakta — **hum bhi nahi.**"

---

## [1:15 – 2:30] Kaise kaam karta hai — 3 ideas

"Teen simple ideas isko chalate hain.

**Pehla — har record signed hai.**
Har device ke paas apni private key hai. Jab wo koi record banata hai, apni key se sign karta hai. Baad mein koi bhi verify kar sakta hai ki ye record kisne banaya. Aur jiske paas key nahi, wo fake record bana hi nahi sakta. Hum Ed25519 use karte hain — deterministic signature scheme, kyunki ECDSA mein weak random number se private key leak ho sakti hai, aur ESP32 jaise chhote chip par ye real risk hai.

**Doosra — har record pichhle se juda hai.**
Har record apne pichhle record ka hash carry karta hai. Ek purana record badlo, uske baad ka har record mismatch ho jayega. Jaise ek numbered register jisme har page pe pichhle page ka summary ho — ek page phaad do, turant pata chal jayega.

**Teesra — kuch bhi delete nahi hota.**
Aur ye sabse important hai. Humari application ke database user ke paas **UPDATE aur DELETE ka permission hi nahi hai** — sirf INSERT aur SELECT. Ye humare code ka promise nahi hai. Ye ek permission hai jo exist hi nahi karti. Aur service boot hote hi check karti hai — agar galti se extra permission mil gaya, service start hi nahi hoti."

---

## [2:30 – 3:15] Hardware + Demo

"Ab practically kaise hota hai.

Strong room mein ek station lagta hai — ESP32, fingerprint reader, aur ek battery-backed clock. Jab paper kholna ho:

**Do alag officials** ko apni ungli lagani padti hai, 2 minute ke window mein. Ek insaan do baar tap kare — system refuse kar deta hai.

Dono match ho jaayein to camera apne aap ek photo leta hai — aur photo store nahi karte, uska **hash** chain mein daalte hain. Matlab proof rehta hai ki wahi photo thi, lekin database photo archive nahi banta.

Phir jab access maanga jaata hai, engine **21 checks** chalata hai — seal serial match hua? key valid hai? device centre par hai? custody window khula hai? dono fingerprint confirm hue?

Ek bhi fail ho — access refuse. Aur **refuse hona bhi record hota hai**, jawab dene se pehle. Chupke se retry karne ka option nahi hai.

*(Yahan demo dikhao — Witness page, dono finger, GRANTED screen with checks)*"

---

## [3:15 – 3:50] Do smart cheezein

"Do design decisions jo main highlight karna chahunga.

**Ek — fingerprint kabhi store nahi hota.**
Reader apne chip par matching karta hai aur sirf 'slot 3 matched, score 187' return karta hai. Database mein koi biometric hai hi nahi. To agar hamara database leak bhi ho jaye, biometric leak nahi ho sakta. DPDP Act 2023 ke under biometric personal data hai — sabse safe position ye hai ki rakho hi mat.

**Do — content key 4 tukdo mein tooti hui hai, 3 se khulti hai.**
Ek insaan akele paper nahi khol sakta. Aur ek tukda **time-locked** hai — wo exam time se pehle exist hi nahi karta. Leak nahi ho sakta kyunki lene ko kuch hai hi nahi. Ye ekmatra genuinely preventive control hai; baaki sab detective hain."

---

## [3:50 – 4:20] Honest limits — ye zaroor bolna

"Ab ek honest baat, jo shayad aap poochenge.

**Mohar mental leak nahi rok sakta.** Agar koi insaan paper dekh ke yaad kar le — koi bhi custody system usko nahi rok sakta. CCTV bhi nahi.

Jo hum kar sakte hain wo ye hai: **kam log dekhein, kam der dekhein, aur agar leak ho to pata chale kisne dekha.** Investigation ka scope 500 logo se ghat ke 2 logo tak simat jaata hai.

Aur ye abhi prototype hai. Production ke liye teen cheezein aur chahiye — hardware attestation verification, external timestamping, aur ek proper auth gateway. Wo humne design kiya hai, banaya nahi. Aur website par bhi wo clearly marked hai — jo built hai wo green, jo planned hai wo amber."

---

## [4:20 – 5:00] Close — differentiation + ask

"Aakhri baat — competition.

Paper custody ke liye koi mashhoor software product hai hi nahi. Humara competitor ek **process** hai — register, seal, aur trust. Wo process 50 saal se same hai.

Aur hum us process ko replace nahi kar rahe. Strong room wahi rahega, do logo ka rule wahi rahega, seal wahi rahega. Hum sirf ek layer add kar rahe hain jo automatically record karta hai — taaki wo record haath se likha hua na ho jo koi bhi baad mein badal sake.

**Ek line mein: hum exam board ka process badalne nahi aaye. Hum unke process ko bina galti ke prove karne ka tareeka de rahe hain.**

Aur sab kuch local network par chalta hai — koi cloud nahi, koi internet nahi, kyunki exam centres mein internet reliable nahi hota.

Thank you sir."

---

## Quick reference — agar interrupt karke poochein

| Sawaal | 10-second jawab |
|---|---|
| Blockchain hai? | Nahi. Signed hash chain hai PostgreSQL par. Blockchain ka tamper-evidence idea liya, distributed overhead nahi |
| Blockchain kyun nahi? | Ek hi exam board hai. Multiple untrusted parties nahi hain, to consensus ki zaroorat nahi |
| Server hack ho jaye to? | Naye records daal sakta hai, purane badal nahi sakta — har device ki private key uske flash mein hai, aur DB mein UPDATE/DELETE permission hi nahi |
| Fingerprint fake ho sakta hai? | Optical sensor presentation attack se fool ho sakta hai. Isliye photo bhi lete hain — do controls ek se better |
| Scale karega? | Architecture karta hai. Har centre independent, Postgres lakhs of records handle karta hai |
| Kitna cost? | Per station ~₹1500 ka hardware. Koi cloud/licensing cost nahi |
