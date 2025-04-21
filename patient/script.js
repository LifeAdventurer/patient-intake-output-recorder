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
      inputWeight: "", // Use empty string for easier validation/placeholder

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
      backgroundSyncIntervalId: null,
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
    // Load essential configs first
    await this.fetchConfig(); // Loads apiUrl, API events and messages
    await this.loadLanguageData(); // Loads supported languages and texts
    this.loadSelectedLanguage(); // Sets initial language based on localStorage or default
    this.updateDateTime(); // Initial date/time set

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
    // --- Initialization & Configuration ---
    async fetchConfig() {
      try {
        const response = await fetch("./config.json");
        if (!response.ok)
          throw new Error(`HTTP error! status: ${response.status}`);
        const config = await response.json();
        this.apiUrl = config.apiUrl;

        const eventsResponse = await fetch("./events.json");
        if (!eventsResponse.ok)
          throw new Error(`HTTP error! status: ${eventsResponse.status}`);
        this.events = await eventsResponse.json();
        console.log("Configuration and events loaded.");
      } catch (error) {
        console.error("Failed to load config.json or events.json:", error);
        // this.showAlert(
        //   this.curLangText?.config_load_error || "無法載入設定",
        //   "danger",
        // );
      }
    },

    async loadLanguageData() {
      try {
        const [langResponse, textsResponse] = await Promise.all([
          fetch("./supported_languages.json"),
          fetch("./lang_texts.json"),
        ]);

        if (!langResponse.ok)
          throw new Error(
            `Failed to load supported_languages.json: ${langResponse.status}`,
          );
        this.supportedLanguages = await langResponse.json();

        if (!textsResponse.ok)
          throw new Error(
            `Failed to load lang_texts.json: ${textsResponse.status}`,
          );
        this.curLangTexts = await textsResponse.json();

        console.log("Language data loaded.");
      } catch (error) {
        console.error("Failed to load language data:", error);
        // Show alert in default language as curLangText might not be available
        this.showAlert("Failed to load language files.", "danger");
      }
    },

    loadSelectedLanguage() {
      const savedLang = localStorage.getItem("selectedLanguageCode");
      // Check if saved language is valid and loaded
      if (
        savedLang &&
        this.supportedLanguages.some((lang) => lang.code === savedLang) &&
        this.curLangTexts[savedLang]
      ) {
        this.selectedLanguage = savedLang;
      } else {
        // If invalid or not loaded, set default and save it
        this.selectedLanguage = "zh-TW"; // Ensure default exists in files
        localStorage.setItem("selectedLanguageCode", this.selectedLanguage);
      }
      console.log("Selected language set to:", this.selectedLanguage);
    },

    /** Initializes the structure for a given date if it doesn't exist */
    initRecordsIfNeeded(dateKey) {
      if (!this.records[dateKey]) {
        console.log(`Initializing records for date: ${dateKey}`);
        const dateParts = dateKey.split("_"); // Expects YYYY_M_D
        const displayDate =
          dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : dateKey; // Basic formatting
        // Use Vue.set or direct assignment for reactivity. Direct should work as `records` is reactive.
        this.records[dateKey] = {
          data: [], // Array to hold individual entries { time, food, water, ... }
          count: 0,
          recordDate: displayDate, // Formatted date M/D for display
          foodSum: 0,
          waterSum: 0,
          urinationSum: 0,
          defecationSum: 0,
          weight: "NaN",
        };
      }
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

    // --- Authentication ---
    async authenticate() {
      if (!this.account || !this.password) {
        return;
      }
      console.log("Attempting patient authentication for:", this.account);
      // fetchRecords doubles as the auth check here
      const fetchedData = await this.fetchRecords();

      if (fetchedData && fetchedData.message) {
        switch (fetchedData.message) {
          case this.events.messages.FETCH_RECORD_SUCCESS:
            this.records = fetchedData["account_records"];
            this.authenticated = true;
            // Store credentials in sessionStorage
            sessionStorage.setItem("account", this.account);
            sessionStorage.setItem("password", this.password);
            console.log("Patient authentication successful.");
            this.setupBackgroundSync(); // Start background sync after successful login
            break;
          case this.events.messages.ACCT_NOT_EXIST:
            this.showAlert(this.curLangText.nonexistent_account, "danger");
            this.resetCredentialsAndState();
            break;
          case this.events.messages.AUTH_FAIL_PASSWORD:
            this.showAlert(this.curLangText.incorrect_password, "danger");
            this.password = "";
            sessionStorage.removeItem("password");
            this.authenticated = false;
            break;
          case this.events.messages.INVALID_ACCT_TYPE: // Should ideally not happen for patient login
            this.showAlert(
              this.curLangText.account_without_permission,
              "danger",
            );
            this.resetCredentialsAndState();
            break;
          default:
            // Handle other specific errors or generic failure
            this.resetCredentialsAndState();
            break;
        }
      } else if (!fetchedData) {
        // Handle case where fetchRecords failed completely (e.g., network error)
        // Alert should have been shown by postRequest/fetchRecords
        this.resetCredentialsAndState();
      }
    },

    resetCredentialsAndState() {
      this.account = "";
      this.password = "";
      this.authenticated = false;
      this.records = {};
      sessionStorage.removeItem("account");
      sessionStorage.removeItem("password");
      this.stopBackgroundSync(); // Stop sync if logged out due to error
    },

    togglePasswordVisibility() {
      this.showPassword = !this.showPassword;
    },

    async confirmLogout() {
      const confirmed = await this.showConfirm(this.curLangText.confirm_logout);
      if (confirmed) {
        console.log("Logging out patient:", this.account);
        this.resetCredentialsAndState();
      }
    },

    // --- Data Input & Processing ---
    /** Validates and retrieves the numeric value from standard or custom inputs */
    getNumericInput(standardValue, customValue) {
      let value = 0;
      if (standardValue === "custom") {
        // Allow empty string in custom input to mean 0 after submit attempt
        const parsed = parseInt(customValue);
        if (!isNaN(parsed) && parsed >= 0) {
          value = parsed;
        } else if (customValue !== "" && (isNaN(parsed) || parsed < 0)) {
          // Invalid custom input
          return null; // Indicate error
        }
        // If customValue is "" and standard is "custom", treat as 0
      } else {
        const parsedStandard = parseInt(standardValue);
        if (!isNaN(parsedStandard) && parsedStandard >= 0) {
          value = parsedStandard;
        }
      }
      return value;
    },

    async addData() {
      // 1. Validate and get numeric inputs
      const foodValue = this.getNumericInput(
        this.inputFood,
        this.customInputFood,
      );
      const waterValue = this.getNumericInput(
        this.inputWater,
        this.customInputWater,
      );
      const urinationValue = this.getNumericInput(
        this.inputUrination,
        this.customInputUrination,
      );
      const defecationValue =
        parseInt(this.inputDefecation) >= 0
          ? parseInt(this.inputDefecation)
          : 0; // Simpler for defecation (no custom)

      const weightValueStr = String(this.inputWeight).trim();
      let weightToSave = null;
      let weightError = false;

      if (weightValueStr !== "") {
        const parsedWeight = parseFloat(weightValueStr);
        if (isNaN(parsedWeight) || parsedWeight <= 0 || parsedWeight > 300) {
          // Allow 0? Validate range. Assuming > 0 and <= 300.
          weightError = true;
        } else {
          weightToSave = Math.round(parsedWeight * 100) / 100; // Round to 2 decimal places
        }
      }

      // Check for validation errors
      if (
        foodValue === null ||
        waterValue === null ||
        urinationValue === null
      ) {
        this.showAlert(
          this.curLangText.please_enter_a_positive_integer,
          "danger",
        );
        return;
      }

      if (weightError) {
        this.showAlert(
          this.curLangText?.weight_abnormal ||
            "Weight input is invalid (must be > 0 and <= 300).",
          "danger",
        );
        return;
      }

      // Check if there's anything to save
      const hasDietaryData =
        foodValue > 0 ||
        waterValue > 0 ||
        urinationValue > 0 ||
        defecationValue > 0;
      const hasWeightData = weightToSave !== null;

      if (!hasDietaryData && !hasWeightData) {
        this.showAlert(
          this.curLangText?.no_data_to_submit ||
            "Please enter some data or weight to record.",
          "warning",
        );
        return; // Nothing to add
      }

      // 2. Prepare data and update records
      const d = new Date();
      const currentTimeFormatted = `${("0" + d.getHours()).slice(-2)}:${("0" + d.getMinutes()).slice(-2)}`;
      const currentDateKey = this.currentDateYY_MM_DD;

      this.initRecordsIfNeeded(currentDateKey); // Ensure today's record structure exists

      let recordUpdated = false;

      // Add dietary data if present
      if (hasDietaryData) {
        const currentDietaryData = {
          time: currentTimeFormatted,
          food: foodValue,
          water: waterValue,
          urination: urinationValue,
          defecation: defecationValue,
        };
        const dailyDataArray = this.records[currentDateKey].data;

        // Merging Logic (ensure robustness)
        const lastRecord = dailyDataArray.pop();
        if (lastRecord && lastRecord.time === currentDietaryData.time) {
          console.log("Merging with last record at time:", lastRecord.time);
          this.dietaryItems.forEach((item) => {
            lastRecord[item] =
              (lastRecord[item] || 0) + currentDietaryData[item];
          });
          dailyDataArray.push(lastRecord); // Push merged record back
        } else {
          if (lastRecord) dailyDataArray.push(lastRecord); // Push previous back if different time
          dailyDataArray.push(currentDietaryData); // Push new record
        }
        // // --- Simplified Add Logic (No Merging) ---
        // dailyDataArray.push(currentDietaryData);
        // console.log("Added new dietary record:", currentDietaryData);

        // Update sums and count
        this.records[currentDateKey].count = dailyDataArray.length;
        this.records[currentDateKey].foodSum += foodValue;
        this.records[currentDateKey].waterSum += waterValue;
        this.records[currentDateKey].urinationSum += urinationValue;
        this.records[currentDateKey].defecationSum += defecationValue;
        recordUpdated = true;
      }

      // Update weight if present
      if (hasWeightData) {
        // Weight is stored per day, not per entry
        this.records[currentDateKey].weight = weightToSave; // Store the numeric value
        console.log(
          `Updated weight for ${currentDateKey} to: ${weightToSave} kg`,
        );
        recordUpdated = true;
      }

      // 3. Reset inputs
      this.inputFood = 0;
      this.inputWater = 0;
      this.inputUrination = 0;
      this.inputDefecation = 0;
      this.customInputFood = "";
      this.customInputWater = "";
      this.customInputUrination = "";
      this.inputWeight = "";

      // 4. Update backend if changes were made
      if (recordUpdated) {
        if (await this.updateRecords()) {
          // Show success notification
          this.showNotification = true;
          setTimeout(() => {
            this.showNotification = false;
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

    /** Determines color for food sum based on restrictions */
    getFoodSumColor() {
      const todayRecord = this.records?.[this.currentDateYY_MM_DD];
      if (
        !todayRecord ||
        !this.records.foodCheckboxChecked ||
        !this.records.limitAmount ||
        isNaN(parseInt(this.records.limitAmount))
      ) {
        return "inherit";
      }
      const limit = parseInt(this.records.limitAmount);
      const foodSum = todayRecord.foodSum ?? 0;
      const waterSum = todayRecord.waterSum ?? 0;
      const total =
        foodSum + (this.records.waterCheckboxChecked ? waterSum : 0);
      return total >= limit ? "red" : "inherit";
    },

    /** Determines color for water sum based on restrictions */
    getWaterSumColor() {
      const todayRecord = this.records?.[this.currentDateYY_MM_DD];
      if (
        !todayRecord ||
        !this.records.waterCheckboxChecked ||
        !this.records.limitAmount ||
        isNaN(parseInt(this.records.limitAmount))
      ) {
        return "inherit";
      }
      const limit = parseInt(this.records.limitAmount);
      const foodSum = todayRecord.foodSum ?? 0;
      const waterSum = todayRecord.waterSum ?? 0;
      const total = waterSum + (this.records.foodCheckboxChecked ? foodSum : 0);
      return total >= limit ? "red" : "inherit";
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

    // --- UI Helpers ---
    showAlert(message, type = "success", duration = 5000) {
      // Use language strings if available
      const msg = this.curLangText?.[message] || message;

      this.bootstrapAlertMessage = msg;
      switch (type) {
        case "danger":
          this.bootstrapAlertClass = "alert-danger";
          break;
        case "warning":
          this.bootstrapAlertClass = "alert-warning";
          break;
        case "info":
          this.bootstrapAlertClass = "alert-info";
          break;
        case "success":
        default:
          this.bootstrapAlertClass = "alert-success";
          break;
      }
      // Clear previous timeout if any
      if (this.alertTimeoutId) clearTimeout(this.alertTimeoutId);
      // Set new timeout
      this.alertTimeoutId = setTimeout(() => {
        this.bootstrapAlertMessage = "";
        this.alertTimeoutId = null;
      }, duration);
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

    changeLanguage(languageCode) {
      if (this.supportedLanguages.some((lang) => lang.code === languageCode)) {
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
