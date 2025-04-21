Vue.createApp({
  data() {
    return {
      // --- Core State ---
      account: "", // Loaded from sessionStorage or URL params
      password: "", // Loaded from sessionStorage or URL params
      authenticated: false,
      apiUrl: "", // Loaded from config.json
      events: {}, // Loaded from events.json
      records: {}, // Holds patient's fetched record data { date_key: { data: [...], ... }, controlKeys... }

      // --- Input State ---
      inputFood: 0,
      inputWater: 0,
      inputUrination: 0,
      inputDefecation: 0,
      customInputFood: "", // For custom value entry
      customInputWater: "", // For custom value entry
      customInputUrination: "", // For custom value entry
      inputWeight: 0,

      // --- UI State ---
      showPassword: false,
      restrictionText: "", // Display text for intake limits
      showNotification: false, // For "Record Saved" feedback
      showScrollButton: false,
      bootstrapAlertMessage: "",
      bootstrapAlertClass: "alert-danger", // Default class
      confirmMessage: "",
      confirmResolver: null, // For Bootstrap confirm modal promise
      confirming: false, // Flag to prevent sync/actions during confirmation modal
      removingRecord: false, // Flag during record removal confirmation/API call

      // --- i18n State ---
      selectedLanguage: "zh-TW", // Default language
      supportedLanguages: [], // Loaded from supported_languages.json
      curLangTexts: {}, // Loaded from lang_texts.json

      // --- Configuration / Constants ---
      // Predefined options for quick input (consider moving to config if dynamic)
      options: [
        { value: 50, label: "50" },
        { value: 100, label: "100" },
        { value: 150, label: "150" },
        { value: 200, label: "200" },
        { value: 250, label: "250" },
        { value: 300, label: "300" },
        { value: 350, label: "350" },
        { value: 400, label: "400" },
      ],
      dietaryItems: ["food", "water", "urination", "defecation"], // For iteration
      dateTimeIntervalId: null,

      // --- Date/Time ---
      currentDate: "", // Formatted date string for display
      currentTime: "", // Formatted time string for display
      currentDateYY_MM_DD: "", // YYYY_M_D format for record keys
    };
  },

  // --- Computed Properties ---
  computed: {
    /** Returns the translation object for the currently selected language */
    curLangText() {
      return (
        this.curLangTexts[this.selectedLanguage] ||
        this.curLangTexts["en"] ||
        {}
      ); // Fallback to English or empty object
    },

    /** Returns record data with date keys reversed for display */
    reversedRecord() {
      const reversedData = {};
      // These keys are part of the patient record but shouldn't be displayed as daily records
      const keysToFilter = [
        "isEditing",
        "limitAmount",
        "foodCheckboxChecked",
        "waterCheckboxChecked",
      ];

      Object.keys(this.records)
        .filter(
          (key) =>
            !keysToFilter.includes(key) && /^\d{4}_\d{1,2}_\d{1,2}$/.test(key),
        ) // Filter control keys and validate format
        .sort((a, b) => b.localeCompare(a)) // Sort keys descending (latest date first)
        .forEach((key) => {
          // Ensure the daily record structure exists before assigning
          if (
            this.records[key] &&
            typeof this.records[key] === "object" &&
            this.records[key].data
          ) {
            reversedData[key] = this.records[key];
          } else {
            console.warn(`Skipping invalid record structure for key: ${key}`);
          }
        });
      return reversedData;
    },
  },

  // --- Watchers ---
  watch: {
    /** Update restriction text and save language preference when changed */
    selectedLanguage(newLang, oldLang) {
      if (newLang !== oldLang) {
        localStorage.setItem("selectedLanguageCode", newLang);
        this.processRestrictionText(); // Re-process with new language strings
        this.updateDateTime(); // Update date format if language changes day names
      }
    },
    /** Re-process restriction text if the underlying record data changes */
    records: {
      handler() {
        this.processRestrictionText();
      },
      deep: true, // Watch for nested changes within the records object
    },
  },

  // --- Lifecycle Hooks ---
  async created() {
    await this.fetchApiUrl();
    await this.loadAPIEvents();
    await this.loadSupportedLanguages();
    await this.loadLangTexts();
    this.loadSelectedLanguage();
    this.updateDateTime();

    // Attempt initial authentication (moved from mounted to ensure config is ready)
    const urlParams = new URLSearchParams(window.location.search);
    const urlAccount = urlParams.get("acct");
    const urlPassword = urlParams.get("pw");
    const sessionAccount = sessionStorage.getItem("account");
    const sessionPassword = sessionStorage.getItem("password");

    const accountToUse = urlAccount || sessionAccount;
    const passwordToUse = urlPassword || sessionPassword;

    if (accountToUse && passwordToUse) {
      this.account = accountToUse;
      this.password = passwordToUse;
      await this.authenticate(); // This fetches initial records if successful
    }
  },

  mounted() {
    // Set up intervals after component is mounted
    this.dateTimeIntervalId = setInterval(this.updateDateTime, 1000);
    globalThis.addEventListener("scroll", this.handleScroll);

    // Set up background data synchronization and visibility handling only if authenticated
    if (this.authenticated) {
      this.setupBackgroundSync();
    }
  },

  beforeUnmount() {
    // Clean up intervals and event listeners
    if (this.dateTimeIntervalId) clearInterval(this.dateTimeIntervalId);
    this.stopBackgroundSync(); // Handles interval clearing and listener removal
    globalThis.removeEventListener("scroll", this.handleScroll);
  },

  // --- Methods ---
  methods: {
    async fetchApiUrl() {
      try {
        const response = await fetch("./config.json");
        const config = await response.json();
        this.apiUrl = config.apiUrl;
      } catch (error) {
        console.error("Failed to load API URL", error);
      }
    },

    async loadAPIEvents() {
      try {
        const response = await fetch("./events.json");
        this.events = await response.json();
      } catch (error) {
        console.error("Failed to load events", error);
      }
    },

    async loadSupportedLanguages() {
      try {
        const response = await fetch("./supported_languages.json");
        this.supportedLanguages = await response.json();
      } catch (error) {
        console.error("Failed to load supported languages", error);
      }
    },

    async loadLangTexts() {
      try {
        const response = await fetch("./lang_texts.json");
        this.curLangTexts = await response.json();
      } catch (error) {
        console.error("Failed to load language texts", error);
      }
    },

    loadSelectedLanguage() {
      const languageCode = localStorage.getItem("selectedLanguageCode");
      if (
        languageCode &&
        this.supportedLanguages.some(
          (language) => language.code === languageCode,
        )
      ) {
        this.selectedLanguage = languageCode;
      } else {
        localStorage.setItem("selectedLanguageCode", this.selectedLanguage);
      }
    },

    initRecords(currentDate) {
      const num = currentDate.split("_");
      this.records[currentDate] = {
        data: [],
        count: 0,
        recordDate: `${num[1]}/${num[2]}`,
        foodSum: 0,
        waterSum: 0,
        urinationSum: 0,
        defecationSum: 0,
        weight: "NaN",
      };
    },

    updateDateTime() {
      const d = new Date();
      const year = d.getFullYear();
      const month = d.getMonth() + 1; // JS months are 0-indexed
      const day = ("0" + d.getDate()).slice(-2);
      const hours = ("0" + d.getHours()).slice(-2);
      const minutes = ("0" + d.getMinutes()).slice(-2);
      const seconds = ("0" + d.getSeconds()).slice(-2);

      // Use language-specific day names if available
      const dayNames = this.curLangText?.day_of_week || [
        "Sun",
        "Mon",
        "Tue",
        "Wed",
        "Thu",
        "Fri",
        "Sat",
      ]; // Default/Fallback
      const dayOfWeek = dayNames[d.getDay()];

      this.currentDate = `${year}.${month}.${day} (${dayOfWeek})`;
      this.currentTime = `${hours}:${minutes}:${seconds}`;
      this.currentDateYY_MM_DD = `${year}_${month}_${day}`; // Key format
    },

    async fetchRecords() {
      try {
        const response = await fetch(this.apiUrl, {
          method: "POST",
          mode: "cors",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            event: this.events.FETCH_RECORD,
            account: this.account,
            password: this.password,
            patient: this.account,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to fetch records.");
        }

        console.log("Successfully fetched the records.");
        return await response.json();
      } catch (error) {
        throw new Error(error.message);
      }
    },

    async updateRecords() {
      try {
        const response = await fetch(this.apiUrl, {
          method: "POST",
          mode: "cors",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            event: this.events.UPDATE_RECORD,
            account: this.account,
            password: this.password,
            patient: this.account,
            data: this.records,
          }),
        });

        if (!response.ok) {
          console.error(
            "Network response was not ok, failed to post patient records.",
          );
          return false;
        }

        const { message } = await response.json();
        if (message === this.events.messages.UPDATE_RECORD_SUCCESS) {
          console.log("Patient records posted successfully");
          return true;
        } else {
          console.error("Error:", message);
          return false;
        }
      } catch (error) {
        console.error("Error during posting patient records:", error);
        return false;
      }
    },

    async authenticate() {
      const fetchedData = await this.fetchRecords();
      if (Object.hasOwn(fetchedData, "message")) {
        switch (fetchedData.message) {
          case this.events.messages.ACCT_NOT_EXIST:
            this.showAlert(
              this.curLangText.nonexistent_account,
              "alert-danger",
            );
            this.account = "";
            this.password = "";
            this.stopBackgroundSync(); // Stop sync if logged out due to error
            break;
          case this.events.messages.AUTH_FAIL_PASSWORD:
            this.showAlert(this.curLangText.incorrect_password, "alert-danger");
            this.password = "";
            break;
          case this.events.messages.INVALID_ACCT_TYPE:
            this.showAlert(
              this.curLangText.account_without_permission,
              "alert-danger",
            );
            this.account = "";
            this.password = "";
            this.stopBackgroundSync(); // Handles interval clearing and listener removal
            break;
          default:
            this.authenticated = true;
            this.records = fetchedData["account_records"];
            this.processRestrictionText();
            sessionStorage.setItem("account", this.account);
            sessionStorage.setItem("password", this.password);
            this.setupBackgroundSync(); // Start background sync after successful login
        }
      }
    },

    togglePasswordVisibility() {
      this.showPassword = !this.showPassword;
    },

    async confirmLogout() {
      const confirmed = await this.showConfirm(this.curLangText.confirm_logout);
      if (confirmed) {
        this.account = "";
        this.password = "";
        this.authenticated = false;
        sessionStorage.removeItem("account");
        sessionStorage.removeItem("password");
      }
    },

    async addData() {
      const d = new Date();
      const currentDate = `${d.getFullYear()}_${d.getMonth() + 1}_${(
        "0" + d.getDate()
      ).slice(-2)}`;
      // Food, Water, Urination, Defecation
      if (!this.handleCustomInput()) {
        this.showAlert(
          this.curLangText.please_enter_a_positive_integer,
          "alert-danger",
        );
        return;
      }
      if (
        this.inputFood ||
        this.inputWater ||
        this.inputUrination ||
        this.inputDefecation
      ) {
        if (!this.records[currentDate]) {
          this.initRecords(currentDate);
        }
        const currentData = {
          time: `${("0" + d.getHours()).slice(-2)}:${(
            "0" + d.getMinutes()
          ).slice(-2)}`,
          food: parseInt(this.inputFood),
          water: parseInt(this.inputWater),
          urination: parseInt(this.inputUrination),
          defecation: parseInt(this.inputDefecation),
        };
        const lastRecord = this.records[currentDate]["data"].pop();
        if (lastRecord !== undefined) {
          if (lastRecord["time"] === currentData["time"]) {
            for (const dietaryItem of this.dietaryItems) {
              lastRecord[dietaryItem] += currentData[dietaryItem];
            }
            this.records[currentDate]["data"].push(lastRecord);
          } else {
            this.records[currentDate]["data"].push(lastRecord);
            this.records[currentDate]["data"].push(currentData);
          }
        } else {
          this.records[currentDate]["data"].push(currentData);
        }
        this.records[currentDate]["count"] =
          this.records[currentDate]["data"].length;
        // sums
        this.records[currentDate]["foodSum"] += parseInt(this.inputFood);
        this.records[currentDate]["waterSum"] += parseInt(this.inputWater);
        this.records[currentDate]["urinationSum"] += parseInt(
          this.inputUrination,
        );
        this.records[currentDate]["defecationSum"] += parseInt(
          this.inputDefecation,
        );
        // init again
        this.inputFood = 0;
        this.inputWater = 0;
        this.inputUrination = 0;
        this.inputDefecation = 0;
        this.customInputFood = "";
        this.customInputWater = "";
        this.customInputUrination = "";
        // post to database
        if (await this.updateRecords()) {
          this.showNotification = true;
          setTimeout(() => {
            this.hideNotification();
          }, 2000);
        }
      }
      if (this.inputWeight === 0) {
        return;
      }
      const inputWeight = parseFloat(this.inputWeight);
      if (isNaN(inputWeight) || inputWeight < 0.01 || inputWeight > 300) {
        this.showAlert(this.curLangText.weight_abnormal, "alert-danger");
      } else {
        if (!this.records[currentDate]) {
          this.initRecords(currentDate);
        }
        this.records[currentDate]["weight"] = `${
          Math.round(inputWeight * 100) / 100
        } kg`;
        // init again
        this.inputWeight = 0;
        // post to database
        if ((await this.updateRecords()) && this.showNotification === false) {
          this.showNotification = true;
          setTimeout(() => {
            this.hideNotification();
          }, 2000);
        }
      }
    },

    processRestrictionText() {
      if (
        !isNaN(this.records["limitAmount"]) &&
        String(this.records["limitAmount"]).trim() !== ""
      ) {
        const text = [];
        if (
          this.records["foodCheckboxChecked"] &&
          this.records["waterCheckboxChecked"]
        ) {
          text.push(this.curLangText.limit_food_and_water_to_no_more_than);
        } else if (this.records["foodCheckboxChecked"]) {
          text.push(this.curLangText.limit_food_to_no_more_than);
        } else if (this.records["waterCheckboxChecked"]) {
          text.push(this.curLangText.limit_water_to_no_more_than);
        }
        text.push(this.records["limitAmount"], this.curLangText.grams);
        this.restrictionText = text.join("");
      }
    },

    getFoodSumColor() {
      let exceed = false;
      if (this.records["foodCheckboxChecked"]) {
        exceed =
          this.records[this.currentDateYY_MM_DD]["foodSum"] +
            (this.records["waterCheckboxChecked"]
              ? this.records[this.currentDateYY_MM_DD]["waterSum"]
              : 0) >
          this.records["limitAmount"];
      }
      return exceed ? "red" : "inherit";
    },

    getWaterSumColor() {
      let exceed = false;
      if (this.records["waterCheckboxChecked"]) {
        exceed =
          this.records[this.currentDateYY_MM_DD]["waterSum"] +
            (this.records["foodCheckboxChecked"]
              ? this.records[this.currentDateYY_MM_DD]["foodSum"]
              : 0) >
          this.records["limitAmount"];
      }
      return exceed ? "red" : "inherit";
    },

    async removeRecord(target) {
      this.confirming = true;
      const confirmed = await this.showConfirm(
        this.curLangText.confirm_remove_record,
      );
      if (confirmed) {
        this.removingRecord = true;
        const [date, index] = target.attributes.id.textContent.split("-");

        const record = this.records[date]["data"][index];
        this.records[date]["count"] -= 1;
        for (const dietaryItem of this.dietaryItems) {
          this.records[date][`${dietaryItem}Sum`] -= record[dietaryItem];
        }
        this.records[date]["data"].splice(index, 1);

        await this.updateRecords();
        this.removingRecord = false;
      }
      this.confirming = false;
    },

    showAlert(message, type = "success") {
      this.bootstrapAlertMessage = message;
      this.bootstrapAlertClass =
        type === "success" ? "alert-success" : "alert-danger";

      setTimeout(() => {
        this.bootstrapAlertMessage = "";
      }, 5000);
    },

    showConfirm(message) {
      this.confirmMessage = message;

      return new Promise((resolve) => {
        this.confirmResolver = resolve;

        const confirmModal = document.getElementById("confirmModal");
        const modal = new bootstrap.Modal(confirmModal);
        modal.show();
      });
    },

    handleConfirm(result) {
      const confirmModal = document.getElementById("confirmModal");
      const modal = bootstrap.Modal.getInstance(confirmModal);
      modal.hide();

      if (this.confirmResolver) {
        this.confirmResolver(result);
        this.confirmResolver = null;
      }
    },

    hideNotification() {
      this.showNotification = false;
    },

    handleCustomInput() {
      if (this.inputFood === "custom") {
        const intValue = parseInt(this.customInputFood);
        if (isNaN(intValue) || intValue < 0) return false;
        this.inputFood = intValue;
        this.customInputFood = "";
      }
      if (this.inputWater === "custom") {
        const intValue = parseInt(this.customInputWater);
        if (isNaN(intValue) || intValue < 0) return false;
        this.inputWater = intValue;
        this.customInputWater = "";
      }
      if (this.inputUrination === "custom") {
        const intValue = parseInt(this.customInputUrination);
        if (isNaN(intValue) || intValue < 0) return false;
        this.inputUrination = intValue;
        this.customInputUrination = "";
      }
      return true;
    },

    changeLanguage(languageCode) {
      if (this.suppportedLanguages.some((lang) => lang.code === languageCode)) {
        this.selectedLanguage = languageCode;
        // Watcher will handle localStorage update and text processing
      } else {
        console.warn(
          `Attempted to change to unsupported language: ${languageCode}`,
        );
      }
    },

    scrollToTop() {
      globalThis.scrollTo({
        top: 0,
        behavior: "smooth",
      });
    },

    handleScroll() {
      this.showScrollButton = globalThis.scrollY > 200; // Show after scrolling down a bit more
    },

    // --- Background Sync ---
    setupBackgroundSync() {
      document.addEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );
      this.handleVisibilityChange(); // Run once to set initial state
    },

    startBackgroundSyncInterval() {
      if (this.backgroundSyncIntervalId === null && this.authenticated) {
        console.log("Starting background sync interval...");
        // Run fetch immediately once, then set interval
        this.fetchRecords();
        // Fetch records periodically
        this.backgroundSyncIntervalId = setInterval(this.fetchRecords, 3000);
      }
    },

    stopBackgroundSync() {
      if (this.backgroundSyncIntervalId !== null) {
        console.log("Stopping background sync interval.");
        clearInterval(this.backgroundSyncIntervalId);
        this.backgroundSyncIntervalId = null;
      }
      document.removeEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );
    },

    handleVisibilityChange() {
      if (!this.authenticated) return; // Only run if logged in

      if (document.hidden) {
        console.log("Page hidden, stopping background sync.");
        this.stopBackgroundSync(); // Clear interval when tab is hidden
      } else {
        console.log("Page visible, starting background sync.");
        this.startBackgroundSyncInterval(); // Start interval (will fetch once immediately)
      }
    },
  }, // End Methods
}).mount("#app");
