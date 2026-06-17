async function test() {
  try {
    const params = new URLSearchParams({
      locationId: "-2128838",
      checkinDate: "2026-06-01",
      checkoutDate: "2026-06-03"
    });

    const res = await fetch(
      `http://localhost:3000/hotel-search?${params.toString()}`
    );

    const data = await res.json();

    console.log("HOTELS DATA:", data);

  } catch (error) {
    console.error("ERROR:", error);
  }
}

test();