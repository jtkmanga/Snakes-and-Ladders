# วิธีเปิดระบบ Google Login และ Slip2Go บนมือถือ

## สิ่งที่เตรียมสำเร็จแล้ว
- Google Sign-in หน้าเกม และการตรวจ Firebase ID Token ที่ Cloudflare Worker
- ระบบความปลอดภัยปฏิเสธการสวมรอย UID และคำสั่งซื้อที่ไม่ได้รับการตรวจ
- บัญชีคะแนน Free/VIP แยกกัน; ห้องละ 3 คน; Server สุ่มลูกเต๋าและ Lucky Box
- ฐานข้อมูลใบสั่งซื้อและกันการใช้สลิปหนึ่งธุรกรรมซ้ำ
- สมาชิก VIP ไม่เกิน 100 คน; ราคา 100 บาท/30 วัน; Win Bonus ×2 20 บาท/24 ชม.; เกราะ 10 บาท/24 ชม.

## สิ่งที่ทำต่อบนโทรศัพท์ (อย่าส่ง Secret มาทางแชต)
1. เข้า Firebase Console → Authentication → Sign-in method → Google → Enable → เลือก Project support email → Save
2. Firebase → Project settings (รูปเฟือง) → General → เพิ่ม Web app `</>` แล้วจดค่า `apiKey`, `authDomain`, `projectId`, `appId` สำหรับ Worker
3. ติดตั้ง/Deploy โค้ด v0.5 ขึ้น Cloudflare Staging ใหม่ก่อน **โดย PAYMENTS_ENABLED=false** แล้วนำชื่อโดเมน Worker จริงไปใส่ Firebase → Authentication → Settings → Authorized domains
4. Cloudflare Worker → Settings → Variables and Secrets เพิ่ม `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` ให้ตรงกับ Web app นั้น (ค่า SDK Web เป็น public config ไม่ใช่ Admin secret)
5. ทดสอบ Google Login จากมือถือ และทดสอบว่าไม่ล็อกอินแล้วเข้า `/api/me` หรือจับคู่ไม่ได้
6. Slip2Go → API Connect → Authentication ตรวจสอบ Secret Key และ API endpoint ที่ออกให้ร้าน
7. Cloudflare **Secret** ใส่ `SLIP2GO_SECRET` และ Variables/Secrets ใส่ `SLIP2GO_API_BASE_URL` (origin ของ API ที่ยืนยันจากคู่มือ), `MERCHANT_ACCOUNT_TYPE`, `MERCHANT_ACCOUNT_NUMBER` และชื่อบัญชีจริง `MERCHANT_ACCOUNT_NAME_TH` หากมี; เพิ่ม `MERCHANT_DISPLAY_NAME`, `MERCHANT_PUBLIC_ACCOUNT` ที่อนุญาตให้ผู้เล่นเห็นเพื่อโอนเงิน
8. ทดลองสลิปจริง 1 รายการใน staging แล้วตรวจ: จำนวนเงิน, บัญชีรับเงิน, เวลา, ห้ามสลิปซ้ำ, การนับ VIP และวันหมดอายุ; หากตรวจผ่านแต่ยังไม่ได้สิทธิ์ อย่าโอนซ้ำ ให้ใช้คำสั่งซื้อเดิมตรวจซ้ำ/ให้แอดมินดู
9. เมื่อทดสอบครบแล้ว จึงเปลี่ยน `PAYMENTS_ENABLED` เป็น `true` เพื่อเปิดรับจ่ายเงินจริง **โดยเจ้าของโครงการอนุญาตก่อน**

### ความปลอดภัย
- ไม่ใส่ Slip2Go Secret ใน `public/`, GitHub หรือแชต
- อย่าใช้บัญชีรับเงินจำลอง หรือกำหนดเงินปลอมในการทดลองผลิตภัณฑ์
- อย่าเปิด public payment ก่อนทดสอบด้านบน
- สลิปมีข้อมูลส่วนบุคคล: โค้ดนี้ส่งรูปไปผู้ตรวจสอบเท่านั้นโดยไม่เก็บรูปฝั่งเซิร์ฟเวอร์; แต่ต้องมีนโยบายข้อมูลและการแก้ไขข้อพิพาทก่อนเปิดจริง
- สลิปตรวจผ่านไม่ได้แปลว่าเงินเข้าจริงในทุกกรณี: ทวนยอดและประวัติร้าน Slip2Go/ธนาคารทุกครั้ง

## ทดสอบโค้ดในเครื่อง
`npm install && npm run check`

ระบบนี้ยัง **ไม่ได้ Deploy** และยัง **ไม่สามารถรับเงินจริง** จนกว่าจะตั้งค่าครบและผ่านการทดสอบกับธนาคาร/Slip2Go
