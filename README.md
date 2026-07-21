# مدير الحملات الاحترافي — Email Campaign Manager

نظام إدارة حملات بريد إلكتروني كامل: مصادقة JWT، حسابات إرسال مشفّرة (AES-256-GCM)، رفع قوائم، طابور إرسال (BullMQ + Redis)[...]

## لا يوجد تسجيل دخول
هذا تطبيق لمستخدم واحد (أنت). ما فيه صفحة تسجيل/إنشاء حساب — كل البيانات تخص حساب واحد ثابت يتزرع تلقائيًا أو[...]
- إذا سيبت `APP_PASSWORD` فاضي بملف `.env` → الموقع **مفتوح بالكامل** لأي حد يعرف الرابط.
- إذا حطيت قيمة لـ `APP_PASSWORD` → أول ما حد يفتح الموقع بيطلب منه كلمة مرور واحدة بسيطة (مو صفحة تسجيل، مجرد قفل عل[...]

## ميزات إضافية
- **تصنيف/Tags**: ارفع CSV بعمود `tag` واكتب تصنيف بخانة "أرسل فقط لتصنيف معيّن" وقت الإنشاء
- **حقول مخصصة**: أي عمود إضافي بالـ CSV (غير email/firstName/lastName/company/tag/priority) يصير متاح بالمحتوى كـ `{{اسم_العمود}}`
- **أولوية VIP**: عمود `priority` بالـ CSV (رقم أعلى = يُرسل أول)
- **نطاقات محظورة**: تبويب حسابات → قسم "نطاقات محظورة"
- **جدولة**: اختر وقت مستقبلي وقت الإنشاء، التطبيق يفحص كل دقيقة ويبدأ الحملة تلقائيًا
- **إرسال تجريبي**: زر "✉️ إرسال تجريبي" بجانب أي حملة — يرسل نسخة لإيميلك بدون ما يأثر على الإحصائيات
- **تصدير CSV**: زر "⬇️ CSV" بجانب أي حملة لتقرير كامل بكل مستلم وحالته
- **فحص Spam Score**: زر بتبويب الإنشاء — فحص بدائي (مو بديل عن اختبار حقيقي بصندوق وارد)
- **وضع ليلي/نهاري**: زر 🌓 بجانب التبويبات

## المزودون المدعومون
- SMTP (Gmail/Outlook/أي سيرفر SMTP)
- Brevo (API)
- Amazon SES (عبر SMTP interface)
- Mailgun (HTTP API)
- SendGrid (HTTP API v3)

## التشغيل محلياً (Docker)
```bash
cp .env.example .env
# عدّل JWT_SECRET و ENCRYPTION_KEY لقيم عشوائية طويلة
docker-compose up --build
npx prisma migrate dev --name init
```
الموقع على http://localhost:3000، وتوثيق API على http://localhost:3000/api-docs

## النشر على Railway
1. أنشئ مشروع جديد واربطه بمستودع GitHub (عبر Working Copy).
2. أضف Add-on لـ PostgreSQL و Redis من Railway (أو استخدم Supabase لقاعدة البيانات).
3. اضبط متغيرات البيئة (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `APP_URL`).
4. شغّل `npx prisma migrate deploy` من تبويب Railway Shell أو أضفه كـ "Release Command".

## أمثلة على `config` لكل مزود عند إضافة حساب
```json
// smtp
{ "host": "smtp.gmail.com", "port": 465, "secure": true, "username": "you@gmail.com", "password": "app-password", "fromEmail": "you@gmail.com" }

// brevo
{ "apiKey": "xkeysib-...", "fromEmail": "you@yourdomain.com" }

// ses
{ "region": "eu-west-1", "smtpUsername": "AKIA...", "smtpPassword": "...", "fromEmail": "you@yourdomain.com" }

// mailgun
{ "apiKey": "key-...", "domain": "mg.yourdomain.com", "fromEmail": "you@yourdomain.com" }

// sendgrid
{ "apiKey": "SG....", "fromEmail": "you@yourdomain.com" }
```

## الاختبارات
```bash
npm test
```

## نقاط مهمة قبل الاستخدام الفعلي
- **لا ترسل لقوائم مشتراة** — كل مستلم يجب أن يكون موافقًا على الاشتراك، وإلا ستُحظر حسابات الإرسال وتُدرج نط[...]
- تأكد من إعداد SPF/DKIM/DMARC على نطاقك قبل الإرسال الفعلي لتفادي انتهاء الرسائل في الـ Spam.
- ابدأ بحجم إرسال صغير (Warm-up) قبل زيادة العدد اليومي.