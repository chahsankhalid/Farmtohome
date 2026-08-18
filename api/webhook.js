export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).end();
    }

    // ============================================================
    // TOPIC CHECK
    // ============================================================

    const topic = req.headers["x-shopify-topic"];

    console.log("📢 Webhook topic:", topic);

    const allowedTopics = ["orders/create", "orders/paid"];

    if (!allowedTopics.includes(topic)) {
      console.log("⏭️ Ignored topic:", topic);
      return res.status(200).end();
    }

    // ============================================================
    // GET ORDER
    // ============================================================

    const order = req.body;

    if (!order?.id) {
      console.log("⏭️ Invalid order payload");
      return res.status(200).end();
    }

    console.log("🧾 Shopify order received:", order.id);
    console.log("🧾 Order name:", order.name);


    // ============================================================
    // PREVENT DUPLICATES
    // ============================================================

    const alreadyProcessed = order.note_attributes?.some(
      attr =>
        attr.name?.toLowerCase() === "processed-by" &&
        attr.value === "middleware"
    );

    if (alreadyProcessed) {
      console.log("⏭️ Already processed order:", order.id);
      return res.status(200).end();
    }


    // ============================================================
    // DETECT RECHARGE / SUBSCRIPTION ORDER
    // ============================================================

    const isRecharge =
      order.source_name === "subscription_contract" ||
      order.tags?.toLowerCase().includes("subscription") ||
      order.line_items?.some(
        item => item.selling_plan_allocation
      );

    console.log("🔄 Recharge/subscription:", isRecharge);


    // ============================================================
    // READ EXISTING ORDER ATTRIBUTES
    // ============================================================

    const existingAttributes = [
      ...(order.note_attributes || [])
    ];

    let deliveryString = null;
    let deliveryDay = null;
    let deliveryTime = null;


    // ============================================================
    // FIND DELIVERY DATE
    // ============================================================

    const deliveryDateAttribute = existingAttributes.find(
      attr =>
        attr.name?.toLowerCase() === "delivery date"
    );

    if (deliveryDateAttribute?.value) {
      deliveryString = String(
        deliveryDateAttribute.value
      ).trim();
    }


    // ============================================================
    // FIND delivery_day
    // ============================================================

    const deliveryDayAttribute = existingAttributes.find(
      attr =>
        attr.name?.toLowerCase() === "delivery_day"
    );

    if (deliveryDayAttribute?.value) {
      deliveryDay = String(
        deliveryDayAttribute.value
      ).trim();
    }


    // ============================================================
    // FIND delivery_time
    // ============================================================

    const deliveryTimeAttribute = existingAttributes.find(
      attr =>
        attr.name?.toLowerCase() === "delivery_time"
    );

    if (deliveryTimeAttribute?.value) {
      deliveryTime = String(
        deliveryTimeAttribute.value
      ).trim();
    }


    // ============================================================
    // ALSO CHECK LINE ITEM PROPERTIES
    // ============================================================

    if (!deliveryString) {
      for (const item of order.line_items || []) {
        for (const prop of item.properties || []) {
          if (
            prop.name?.toLowerCase() === "delivery date" &&
            prop.value
          ) {
            deliveryString = String(
              prop.value
            ).trim();

            break;
          }
        }

        if (deliveryString) break;
      }
    }


    console.log(
      "📦 Existing Delivery date:",
      deliveryString
    );

    console.log(
      "📅 Existing delivery_day:",
      deliveryDay
    );

    console.log(
      "⏰ Existing delivery_time:",
      deliveryTime
    );


    // ============================================================
    // DETERMINE WHETHER EXISTING DATE SHOULD BE PRESERVED
    // OR RECALCULATED
    // ============================================================

    let shouldRecalculate = false;


    // ------------------------------------------------------------
    // CASE 1
    //
    // No delivery date exists.
    //
    // This includes:
    //
    // Direct Shopify checkout
    // Recharge order without delivery information
    // ------------------------------------------------------------

    if (!deliveryString) {
      console.log(
        "⚠️ No Delivery date found"
      );

      shouldRecalculate = true;
    }


    // ------------------------------------------------------------
    // CASE 2
    //
    // Recharge renewal.
    //
    // If Recharge copied an OLD delivery date into the new order,
    // the delivery date will be before the new order date.
    //
    // In that situation we calculate a new delivery date.
    // ------------------------------------------------------------

    if (isRecharge && deliveryString) {
      const existingDeliveryDate =
        parseDeliveryDate(deliveryString);

      if (existingDeliveryDate) {
        const orderDate =
          getLisbonCalendarDate(
            order.created_at
          );

        const deliveryDate =
          getLisbonCalendarDate(
            existingDeliveryDate.toISOString()
          );

        console.log(
          "📅 Order calendar date:",
          orderDate
        );

        console.log(
          "📅 Existing delivery calendar date:",
          deliveryDate
        );


        if (deliveryDate < orderDate) {
          console.log(
            "🔄 Recharge renewal detected"
          );

          console.log(
            "⚠️ Existing delivery date is in the past"
          );

          shouldRecalculate = true;
        }
      }
    }


    // ============================================================
    // CALCULATE NEW DELIVERY
    // ============================================================

    if (shouldRecalculate) {
      const defaultDelivery =
        getDefaultDelivery(
          order.created_at
        );

      deliveryString =
        defaultDelivery.deliveryString;

      deliveryDay =
        defaultDelivery.deliveryDay;

      deliveryTime =
        defaultDelivery.deliveryTime;


      console.log(
        "📦 New delivery date:",
        deliveryString
      );

      console.log(
        "📅 New delivery day:",
        deliveryDay
      );

      console.log(
        "⏰ New delivery time:",
        deliveryTime
      );
    }


    // ============================================================
    // IF EXISTING DELIVERY WAS KEPT
    // MAKE SURE delivery_day AND delivery_time EXIST
    // ============================================================

    if (deliveryString) {
      const extracted =
        extractDeliveryInfo(
          deliveryString
        );

      if (extracted) {

        if (!deliveryDay) {
          deliveryDay =
            normalizeDay(
              extracted.day
            );
        }

        if (!deliveryTime) {
          deliveryTime =
            extracted.time;
        }
      }
    }


    // ============================================================
    // FINAL SAFETY DEFAULTS
    // ============================================================

    if (!deliveryDay) {
      deliveryDay = "wednesday";
    }

    if (!deliveryTime) {
      deliveryTime = "19:00-21:00";
    }


    // ============================================================
    // UPDATE ATTRIBUTES
    //
    // IMPORTANT:
    //
    // We start with ALL existing attributes.
    //
    // Therefore:
    //
    // Marketing WhatsApp → preserved
    // Marketing Email    → preserved
    // Recharge fields    → preserved
    // Other attributes   → preserved
    //
    // Only delivery fields are changed.
    // ============================================================

    const updatedAttributes = [
      ...existingAttributes
    ];


    upsertAttribute(
      updatedAttributes,
      "delivery_day",
      deliveryDay
    );


    upsertAttribute(
      updatedAttributes,
      "delivery_time",
      deliveryTime
    );


    upsertAttribute(
      updatedAttributes,
      "Delivery date",
      deliveryString
    );


    upsertAttribute(
      updatedAttributes,
      "Processed-By",
      "middleware"
    );


    console.log(
      "📝 Final order attributes:",
      updatedAttributes
    );


    // ============================================================
    // UPDATE SHOPIFY ORDER
    // ============================================================

    const shopifyResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",

        headers: {
          "X-Shopify-Access-Token":
            process.env.SHOPIFY_TOKEN,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          query: `
            mutation OrderUpdate($input: OrderInput!) {
              orderUpdate(input: $input) {
                order {
                  id

                  customAttributes {
                    key
                    value
                  }
                }

                userErrors {
                  field
                  message
                }
              }
            }
          `,

          variables: {
            input: {
              id:
                `gid://shopify/Order/${order.id}`,

              customAttributes:
                updatedAttributes.map(attr => ({
                  key: attr.name,
                  value: String(
                    attr.value ?? ""
                  )
                }))
            }
          }
        })
      }
    );


    const data =
      await shopifyResponse.json();


    console.log(
      "📡 Shopify response:",
      JSON.stringify(
        data,
        null,
        2
      )
    );


    // ============================================================
    // SHOPIFY HTTP ERROR
    // ============================================================

    if (!shopifyResponse.ok) {
      console.error(
        "❌ Shopify HTTP error:",
        shopifyResponse.status,
        data
      );

      return res
        .status(500)
        .send("Shopify API error");
    }


    // ============================================================
    // GRAPHQL ERROR
    // ============================================================

    if (data.errors?.length) {
      console.error(
        "❌ Shopify GraphQL errors:",
        data.errors
      );

      return res
        .status(500)
        .send("Shopify GraphQL error");
    }


    // ============================================================
    // USER ERRORS
    // ============================================================

    const userErrors =
      data.data?.orderUpdate?.userErrors || [];


    if (userErrors.length) {
      console.error(
        "❌ Shopify orderUpdate errors:",
        userErrors
      );

      return res
        .status(500)
        .send(
          "Shopify order update failed"
        );
    }


    console.log(
      "✅ Shopify order updated:",
      order.id
    );


    return res
      .status(200)
      .send("Updated");

  } catch (err) {

    console.error(
      "❌ Webhook error:",
      err
    );

    return res
      .status(500)
      .send("Error");
  }
}


// ============================================================
// EXTRACT DELIVERY INFO
// ============================================================

function extractDeliveryInfo(
  deliveryString
) {
  try {

    const parts =
      deliveryString.split(" - ");

    const dayTime =
      parts[0];

    const datePart =
      parts.slice(1).join(" - ");


    const dayMatch =
      dayTime.match(
        /^(.*?)\s*\(/
      );


    const timeMatch =
      dayTime.match(
        /\((.*?)\)/
      );


    const day =
      dayMatch?.[1]?.trim();

    const time =
      timeMatch?.[1]?.trim();

    const date =
      datePart?.trim();


    if (
      !day ||
      !time ||
      !date
    ) {
      return null;
    }


    return {
      day,
      time,
      date
    };

  } catch (err) {

    console.error(
      "❌ Delivery extraction failed:",
      err
    );

    return null;
  }
}


// ============================================================
// PARSE DELIVERY DATE
//
// Supports:
//
// 19 Aug 2026
// 19/08/2026
// 19-08-2026
// ============================================================

function parseDeliveryDate(
  deliveryString
) {
  try {

    const extracted =
      extractDeliveryInfo(
        deliveryString
      );

    if (!extracted?.date) {
      return null;
    }


    const dateString =
      extracted.date.trim();


    // ----------------------------------------------------------
    // DD/MM/YYYY
    // ----------------------------------------------------------

    let match =
      dateString.match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
      );


    if (match) {

      const day =
        Number(match[1]);

      const month =
        Number(match[2]) - 1;

      const year =
        Number(match[3]);


      return new Date(
        Date.UTC(
          year,
          month,
          day
        )
      );
    }


    // ----------------------------------------------------------
    // DD-MM-YYYY
    // ----------------------------------------------------------

    match =
      dateString.match(
        /^(\d{1,2})-(\d{1,2})-(\d{4})$/
      );


    if (match) {

      const day =
        Number(match[1]);

      const month =
        Number(match[2]) - 1;

      const year =
        Number(match[3]);


      return new Date(
        Date.UTC(
          year,
          month,
          day
        )
      );
    }


    // ----------------------------------------------------------
    // DD Mon YYYY
    //
    // Example:
    // 19 Aug 2026
    // ----------------------------------------------------------

    match =
      dateString.match(
        /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/
      );


    if (match) {

      const day =
        Number(match[1]);

      const monthName =
        match[2].toLowerCase();

      const year =
        Number(match[3]);


      const months = {
        jan: 0,
        january: 0,

        feb: 1,
        february: 1,

        mar: 2,
        march: 2,

        apr: 3,
        april: 3,

        may: 4,

        jun: 5,
        june: 5,

        jul: 6,
        july: 6,

        aug: 7,
        august: 7,

        sep: 8,
        sept: 8,
        september: 8,

        oct: 9,
        october: 9,

        nov: 10,
        november: 10,

        dec: 11,
        december: 11
      };


      if (
        months[monthName] === undefined
      ) {
        return null;
      }


      return new Date(
        Date.UTC(
          year,
          months[monthName],
          day
        )
      );
    }


    return null;

  } catch (err) {

    console.error(
      "❌ Date parsing failed:",
      err
    );

    return null;
  }
}


// ============================================================
// GET LISBON CALENDAR DATE
//
// Returns:
// YYYY-MM-DD
//
// This prevents timezone/DST issues.
// ============================================================

function getLisbonCalendarDate(
  dateInput
) {

  const date =
    new Date(dateInput);


  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Europe/Lisbon",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    ).formatToParts(date);


  const year =
    parts.find(
      p => p.type === "year"
    )?.value;


  const month =
    parts.find(
      p => p.type === "month"
    )?.value;


  const day =
    parts.find(
      p => p.type === "day"
    )?.value;


  return `${year}-${month}-${day}`;
}


// ============================================================
// NORMALIZE DAY
// ============================================================

function normalizeDay(day) {

  const dayMap = {

    sunday:
      "sunday",

    monday:
      "monday",

    tuesday:
      "tuesday",

    wednesday:
      "wednesday",

    thursday:
      "thursday",

    friday:
      "friday",

    saturday:
      "saturday",


    domingo:
      "sunday",

    "segunda-feira":
      "monday",

    "terça-feira":
      "tuesday",

    "terca-feira":
      "tuesday",

    "quarta-feira":
      "wednesday",

    "quinta-feira":
      "thursday",

    "sexta-feira":
      "friday",

    "sábado":
      "saturday",

    sabado:
      "saturday"
  };


  return (
    dayMap[
      day?.toLowerCase()
    ] ||
    "wednesday"
  );
}


// ============================================================
// DEFAULT DELIVERY
//
// EXACTLY MATCHES YOUR CART LOGIC:
//
// Sunday    → upcoming Wednesday
// Monday    → following Wednesday
// Tuesday   → following Wednesday
// Wednesday → following Wednesday
// Thursday  → upcoming Wednesday
// Friday    → upcoming Wednesday
// Saturday  → upcoming Wednesday
//
// Default time:
//
// 19:00-21:00
// ============================================================

function getDefaultDelivery(
  createdAt
) {

  const orderDate =
    new Date(createdAt);


  // Get weekday in Lisbon.

  const weekdayFormatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          "Europe/Lisbon",

        weekday:
          "long"
      }
    );


  const weekdayName =
    weekdayFormatter
      .format(orderDate)
      .toLowerCase();


  const daysMap = {

    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6

  };


  const currentDay =
    daysMap[weekdayName];


  let daysUntilWednesday;


  // ----------------------------------------------------------
  // Monday
  // ----------------------------------------------------------

  if (currentDay === 1) {

    daysUntilWednesday = 9;

  }

  // ----------------------------------------------------------
  // Tuesday
  // ----------------------------------------------------------

  else if (currentDay === 2) {

    daysUntilWednesday = 8;

  }

  // ----------------------------------------------------------
  // Wednesday
  // ----------------------------------------------------------

  else if (currentDay === 3) {

    daysUntilWednesday = 7;

  }

  // ----------------------------------------------------------
  // Thursday-Sunday
  // ----------------------------------------------------------

  else {

    daysUntilWednesday =
      (3 - currentDay + 7) % 7;


    if (
      daysUntilWednesday === 0
    ) {
      daysUntilWednesday = 7;
    }
  }


  // ==========================================================
  // GET ORDER CALENDAR DATE IN LISBON
  // ==========================================================

  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Europe/Lisbon",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    ).formatToParts(orderDate);


  const year =
    Number(
      parts.find(
        p => p.type === "year"
      )?.value
    );


  const month =
    Number(
      parts.find(
        p => p.type === "month"
      )?.value
    );


  const day =
    Number(
      parts.find(
        p => p.type === "day"
      )?.value
    );


  // ==========================================================
  // CREATE DELIVERY DATE
  // ==========================================================

  const deliveryDate =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day + daysUntilWednesday
      )
    );


  const formattedDate =
    deliveryDate.toLocaleDateString(
      "en-GB",
      {
        timeZone:
          "UTC",

        day:
          "2-digit",

        month:
          "short",

        year:
          "numeric"
      }
    );


  return {

    deliveryDay:
      "wednesday",

    deliveryTime:
      "19:00-21:00",

    deliveryString:
      `Wednesday (19:00-21:00) - ${formattedDate}`

  };
}


// ============================================================
// UPSERT ATTRIBUTE
// ============================================================

function upsertAttribute(
  attributes,
  name,
  value
) {

  const index =
    attributes.findIndex(
      attr =>
        attr.name?.toLowerCase() ===
        name.toLowerCase()
    );


  const newAttribute = {

    name,

    value:
      String(
        value ?? ""
      )

  };


  if (index >= 0) {

    attributes[index] =
      newAttribute;

  } else {

    attributes.push(
      newAttribute
    );
  }


  return attributes;
}
