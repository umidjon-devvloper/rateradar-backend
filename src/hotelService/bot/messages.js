// Xodimlarga yuboriladigan xabarlar — mehmonxona tanlagan tilda
const MSGS = {
  en: {
    welcome: "👋 Welcome!\n\nTo join the service system, please register.\n\n✏️ Enter your full name:",
    enterPhone: "📱 Send your phone number:",
    registered: "✅ Registration complete!\n\nWaiting for admin approval.",
    activated: "🎉 You have been added to the system!\n\nYou will now receive service requests.",
    alreadyPending: "⏳ Your registration is already submitted. Please wait for admin approval.",
    alreadyActive: "✅ You are already active in the system.",
    alreadyInactive: "❌ Your account is deactivated. Contact the administrator.",
    invalidName: "⚠️ Name must be at least 3 characters. Please try again:",
    ownContactRequired: "⚠️ Please send your own phone number.",
    sendPhoneAgain: "📱 Please send your phone number using the button:",
    error: "❌ An error occurred. Please try again.",
    alreadyTaken: "⚠️ This request has already been accepted.",
    completed: "✅ Job completed! Thank you.",
    notYourRequest: "⚠️ This request was not assigned to you.",
    newRequest: (room, service, subOpt, desc, time) => {
      let t = `🔔 New Request!\n\n🏠 Room: ${room}\n🛎 Service: ${service}`;
      if (subOpt) t += `\n📋 Type: ${subOpt}`;
      if (desc)   t += `\n💬 Note: ${desc}`;
      t += `\n⏰ ${time}`;
      return t;
    },
    accepted: (room, service) =>
      `✅ Request accepted!\n\n🏠 Room: ${room}\n🛎 Service: ${service}\n\nPress "Done" when finished.`,
    takenByOther: (name) => `ℹ️ This request was taken by <b>${name}</b>.`,
    acceptBtn: "✅ Accept",
    doneBtn: "✅ Done",
  },
  ru: {
    welcome: "👋 Добро пожаловать!\n\nДля входа в систему необходимо зарегистрироваться.\n\n✏️ Введите ваше полное имя:",
    enterPhone: "📱 Отправьте номер телефона:",
    registered: "✅ Регистрация завершена!\n\nОжидайте подтверждения администратора.",
    activated: "🎉 Вы добавлены в систему!\n\nТеперь вам будут поступать заявки.",
    alreadyPending: "⏳ Ваша заявка уже отправлена. Ожидайте подтверждения.",
    alreadyActive: "✅ Вы уже активны в системе.",
    alreadyInactive: "❌ Ваш аккаунт деактивирован. Обратитесь к администратору.",
    invalidName: "⚠️ Имя должно содержать не менее 3 символов. Попробуйте снова:",
    ownContactRequired: "⚠️ Пожалуйста, отправьте свой номер телефона.",
    sendPhoneAgain: "📱 Отправьте номер телефона через кнопку:",
    error: "❌ Произошла ошибка. Попробуйте снова.",
    alreadyTaken: "⚠️ Эта заявка уже принята другим сотрудником.",
    completed: "✅ Работа выполнена! Спасибо.",
    notYourRequest: "⚠️ Эта заявка не принята вами.",
    newRequest: (room, service, subOpt, desc, time) => {
      let t = `🔔 Новая заявка!\n\n🏠 Номер: ${room}\n🛎 Услуга: ${service}`;
      if (subOpt) t += `\n📋 Тип: ${subOpt}`;
      if (desc)   t += `\n💬 Примечание: ${desc}`;
      t += `\n⏰ ${time}`;
      return t;
    },
    accepted: (room, service) =>
      `✅ Заявка принята!\n\n🏠 Номер: ${room}\n🛎 Услуга: ${service}\n\nНажмите "Выполнено" после завершения.`,
    takenByOther: (name) => `ℹ️ Заявку принял(а) <b>${name}</b>.`,
    acceptBtn: "✅ Принять",
    doneBtn: "✅ Выполнено",
  },
  uz: {
    welcome: "👋 Assalomu alaykum!\n\nTizimga kirish uchun ro'yxatdan o'ting.\n\n✏️ Ism familiyangizni kiriting:",
    enterPhone: "📱 Telefon raqamingizni yuboring:",
    registered: "✅ Ro'yxatdan o'tish yakunlandi!\n\nAdmin tasdiqlashini kuting.",
    activated: "🎉 Tizimga qo'shildingiz!\n\nEndi buyurtmalar sizga keladi.",
    alreadyPending: "⏳ Ma'lumotlaringiz allaqachon yuborilgan. Kutib turing.",
    alreadyActive: "✅ Siz allaqachon tizimdasiz.",
    alreadyInactive: "❌ Hisobingiz to'xtatilgan. Admin bilan bog'laning.",
    invalidName: "⚠️ Ism kamida 3 ta harf bo'lishi kerak. Qayta kiriting:",
    ownContactRequired: "⚠️ O'z telefon raqamingizni yuboring.",
    sendPhoneAgain: "📱 Telefon raqamingizni tugma orqali yuboring:",
    error: "❌ Xatolik yuz berdi. Qayta urining.",
    alreadyTaken: "⚠️ Bu buyurtma allaqachon qabul qilingan.",
    completed: "✅ Ish bajarildi! Rahmat.",
    notYourRequest: "⚠️ Bu buyurtma sizga tegishli emas.",
    newRequest: (room, service, subOpt, desc, time) => {
      let t = `🔔 Yangi buyurtma!\n\n🏠 Xona: ${room}\n🛎 Xizmat: ${service}`;
      if (subOpt) t += `\n📋 Tur: ${subOpt}`;
      if (desc)   t += `\n💬 Izoh: ${desc}`;
      t += `\n⏰ ${time}`;
      return t;
    },
    accepted: (room, service) =>
      `✅ Qabul qilindi!\n\n🏠 Xona: ${room}\n🛎 Xizmat: ${service}\n\nIsh tugagach "Bajarildi" tugmasini bosing.`,
    takenByOther: (name) => `ℹ️ Bu buyurtmani <b>${name}</b> qabul qildi.`,
    acceptBtn: "✅ Qabul qilish",
    doneBtn: "✅ Bajarildi",
  },
  tr: {
    welcome: "👋 Hoş Geldiniz!\n\nSisteme katılmak için kayıt olun.\n\n✏️ Adınızı ve soyadınızı girin:",
    enterPhone: "📱 Telefon numaranızı gönderin:",
    registered: "✅ Kayıt tamamlandı!\n\nYönetici onayı bekleniyor.",
    activated: "🎉 Sisteme eklendiniz!\n\nArtık hizmet talepleri alacaksınız.",
    alreadyPending: "⏳ Kaydınız zaten gönderildi. Onay bekleniyor.",
    alreadyActive: "✅ Sistemde zaten aktifsiniz.",
    alreadyInactive: "❌ Hesabınız devre dışı. Yönetici ile iletişime geçin.",
    invalidName: "⚠️ İsim en az 3 karakter olmalıdır. Tekrar deneyin:",
    ownContactRequired: "⚠️ Lütfen kendi telefon numaranızı gönderin.",
    sendPhoneAgain: "📱 Telefon numaranızı düğme ile gönderin:",
    error: "❌ Bir hata oluştu. Tekrar deneyin.",
    alreadyTaken: "⚠️ Bu talep zaten kabul edildi.",
    completed: "✅ İş tamamlandı! Teşekkürler.",
    notYourRequest: "⚠️ Bu talep size ait değil.",
    newRequest: (room, service, subOpt, desc, time) => {
      let t = `🔔 Yeni Talep!\n\n🏠 Oda: ${room}\n🛎 Hizmet: ${service}`;
      if (subOpt) t += `\n📋 Tür: ${subOpt}`;
      if (desc)   t += `\n💬 Not: ${desc}`;
      t += `\n⏰ ${time}`;
      return t;
    },
    accepted: (room, service) =>
      `✅ Talep kabul edildi!\n\n🏠 Oda: ${room}\n🛎 Hizmet: ${service}\n\nBitince "Tamamlandı" düğmesine basın.`,
    takenByOther: (name) => `ℹ️ Bu talebi <b>${name}</b> kabul etti.`,
    acceptBtn: "✅ Kabul Et",
    doneBtn: "✅ Tamamlandı",
  },
  de: {
    welcome: "👋 Willkommen!\n\nZum Beitreten bitte registrieren.\n\n✏️ Geben Sie Ihren vollständigen Namen ein:",
    enterPhone: "📱 Telefonnummer senden:",
    registered: "✅ Registrierung abgeschlossen!\n\nWarte auf Bestätigung des Administrators.",
    activated: "🎉 Sie wurden zum System hinzugefügt!\n\nSie erhalten nun Serviceanfragen.",
    alreadyPending: "⏳ Ihre Registrierung wurde bereits eingereicht.",
    alreadyActive: "✅ Sie sind bereits aktiv.",
    alreadyInactive: "❌ Ihr Konto ist deaktiviert.",
    invalidName: "⚠️ Name muss mindestens 3 Zeichen haben:",
    ownContactRequired: "⚠️ Bitte eigene Nummer senden.",
    sendPhoneAgain: "📱 Bitte Nummer über den Button senden:",
    error: "❌ Fehler aufgetreten. Erneut versuchen.",
    alreadyTaken: "⚠️ Diese Anfrage wurde bereits angenommen.",
    completed: "✅ Arbeit erledigt! Danke.",
    notYourRequest: "⚠️ Diese Anfrage gehört nicht Ihnen.",
    newRequest: (room, service, subOpt, desc, time) => {
      let t = `🔔 Neue Anfrage!\n\n🏠 Zimmer: ${room}\n🛎 Service: ${service}`;
      if (subOpt) t += `\n📋 Typ: ${subOpt}`;
      if (desc)   t += `\n💬 Notiz: ${desc}`;
      t += `\n⏰ ${time}`;
      return t;
    },
    accepted: (room, service) =>
      `✅ Anfrage angenommen!\n\n🏠 Zimmer: ${room}\n🛎 Service: ${service}\n\nDrücken Sie "Erledigt" wenn fertig.`,
    takenByOther: (name) => `ℹ️ Anfrage wurde von <b>${name}</b> angenommen.`,
    acceptBtn: "✅ Annehmen",
    doneBtn: "✅ Erledigt",
  },
  fr: {
    welcome: "👋 Bienvenue!\n\nVeuillez vous inscrire pour rejoindre le système.\n\n✏️ Entrez votre nom complet:",
    enterPhone: "📱 Envoyez votre numéro de téléphone:",
    registered: "✅ Inscription terminée!\n\nEn attente de la confirmation de l'administrateur.",
    activated: "🎉 Vous avez été ajouté au système!\n\nVous recevrez maintenant des demandes.",
    alreadyPending: "⏳ Votre inscription a déjà été soumise.",
    alreadyActive: "✅ Vous êtes déjà actif dans le système.",
    alreadyInactive: "❌ Votre compte est désactivé.",
    invalidName: "⚠️ Le nom doit contenir au moins 3 caractères:",
    ownContactRequired: "⚠️ Veuillez envoyer votre propre numéro.",
    sendPhoneAgain: "📱 Envoyez votre numéro via le bouton:",
    error: "❌ Une erreur s'est produite. Réessayez.",
    alreadyTaken: "⚠️ Cette demande a déjà été acceptée.",
    completed: "✅ Travail terminé! Merci.",
    notYourRequest: "⚠️ Cette demande ne vous appartient pas.",
    newRequest: (room, service, subOpt, desc, time) => {
      let t = `🔔 Nouvelle demande!\n\n🏠 Chambre: ${room}\n🛎 Service: ${service}`;
      if (subOpt) t += `\n📋 Type: ${subOpt}`;
      if (desc)   t += `\n💬 Note: ${desc}`;
      t += `\n⏰ ${time}`;
      return t;
    },
    accepted: (room, service) =>
      `✅ Demande acceptée!\n\n🏠 Chambre: ${room}\n🛎 Service: ${service}\n\nAppuyez sur "Terminé" quand c'est fait.`,
    takenByOther: (name) => `ℹ️ Demande acceptée par <b>${name}</b>.`,
    acceptBtn: "✅ Accepter",
    doneBtn: "✅ Terminé",
  },
};

// Qolgan tillar uchun English ga fallback
const getMsg = (lang) => MSGS[lang] || MSGS.en;

module.exports = { getMsg };
