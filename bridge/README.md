# Bridge — สลับแอปคาราโอเกะ ↔ หน้าโปรโมท บนกล่อง Android

โปรแกรมเล็กๆ รันบน **คอมกลาง** (เครื่อง server เพลง ซึ่งเปิดอยู่ตลอด) คุยกับกล่อง HK1 RBOX ทุกห้องผ่าน **ADB ทางสาย LAN**
ไม่ต้องติดตั้งโปรแกรมเพิ่มนอกจาก ADB (ฟรีจาก Google) ใช้ PowerShell ที่มีใน Windows อยู่แล้ว

| โหมดห้อง (ตั้งในหน้า Admin) | กล่องจะทำอะไร |
|---|---|
| **คาราโอเกะ** | เปิดแอปคาราโอเกะ (ลูกค้ากำลังใช้ห้อง) |
| **อัตโนมัติ** | ไม่มีคนกดรีโมต X นาที (และไม่มีเสียงเล่น) → เปิดหน้าโปรโมท · กดรีโมตปุ่มไหนก็ได้ → กลับแอปคาราโอเกะ |
| เล่นสื่อ / ข้อความ / โลโก้ / ปิดจอ | เปิดแอปโปรโมท (Fully Kiosk) ทันที |

> สั่งงานเฉพาะตอน **เปลี่ยนโหมด** — ถ้าพนักงานกดสลับแอปเองด้วยรีโมต bridge จะไม่ฝืนกลับ (ยกเว้นโหมดอัตโนมัติ)

---

## ติดตั้ง (ทำครั้งเดียว)

### 1) ทุกกล่อง Android
1. ติดตั้ง **Fully Kiosk Browser** จาก Play Store (ตัวฟรีก็ได้)
   - Start URL: `https://patpon.github.io/WebAppcontrolTV/tv.html?room=1` (เลขตามห้อง)
   - Web Content Settings → Autoplay Videos = ON
   - Device Management → Keep Screen On = ON
2. เปิด **ADB debugging**: Settings → About (เกี่ยวกับ) → กด **Build number** 7 ครั้ง → กลับไป Developer options → เปิด **USB debugging** (บางรุ่นมีเมนู **ADB over network / Network debugging** ให้เปิดด้วย)
3. จด **IP ของกล่อง**: Settings → Network → Ethernet → IP address
   แนะนำตั้ง IP คงที่ (หรือจอง IP ใน router) ไม่งั้น IP อาจเปลี่ยนหลังรีสตาร์ท

### 2) คอมกลาง
1. ดาวน์โหลดโฟลเดอร์นี้ (`bridge`) ไปไว้ในคอมกลาง (ดาวน์โหลด ZIP จากหน้า GitHub repo)
2. ดาวน์โหลด **SDK Platform-Tools for Windows** จาก https://developer.android.com/tools/releases/platform-tools
   แตกไฟล์ให้ได้ `bridge\platform-tools\adb.exe`
3. คัดลอก `boxes.example.json` → `boxes.json` แล้วแก้ IP ของแต่ละห้อง (เลขห้องต้องตรงกับในหน้า Admin)
4. ดับเบิลคลิก **`status.bat`**
   - ครั้งแรก กล่องจะขึ้นหน้าต่าง **"Allow USB debugging?"** → ติ๊ก *Always allow* แล้วกด OK ที่รีโมต (ทำทุกกล่อง) แล้วรัน `status.bat` ใหม่
   - เปิดแอปคาราโอเกะค้างไว้ในห้องหนึ่ง แล้วดูช่อง `foreground=` → นั่นคือ **ชื่อ package ของแอปคาราโอเกะ**
5. ไปหน้า Admin → **ตั้งค่า** → ช่อง *แอปคาราโอเกะ (package)* ใส่ชื่อที่ได้ → บันทึก
6. ดับเบิลคลิก **`start-bridge.bat`** (หน้าต่างดำต้องเปิดค้างไว้)
7. ให้เปิดเองตอนเปิดเครื่อง: กด `Win+R` → พิมพ์ `shell:startup` → วาง shortcut ของ `start-bridge.bat` ไว้ในโฟลเดอร์นั้น

## ตรวจปัญหา

| อาการ | แก้ |
|---|---|
| `connect ... failed` / `unable to connect` | IP ผิด, กล่องปิด, หรือยังไม่ได้เปิด USB/Network debugging |
| `unauthorized` | ยังไม่ได้กด Allow บนหน้าจอกล่อง → รัน `status.bat` แล้วกด Allow |
| โหมดอัตโนมัติไม่เปลี่ยนเป็นโปรโมทเลย | แอปคาราโอเกะเปิดเพลงพื้นหลังตลอด → ติ๊ก *ไม่ต้องรอให้เสียงเงียบ* ในหน้า Admin |
| สลับแล้วกล่องเปิดแอปผิด | เช็คชื่อ package ทั้ง 2 ช่องในหน้า Admin → ตั้งค่า |

## ความปลอดภัย
ADB = ควบคุมกล่องได้เต็มที่ — ให้กล่องอยู่บน **LAN/Wi-Fi ของร้าน ที่แยกจาก Wi-Fi ลูกค้า**
`boxes.json` (IP กล่อง) อยู่เฉพาะในคอมกลาง ไม่ถูกส่งขึ้น GitHub
