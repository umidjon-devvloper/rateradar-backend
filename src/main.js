import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();

app.use(cors());

app.get("/hotel-search", async (req, res) => {
  try {
    const { locationId, checkinDate, checkoutDate } = req.query;

    const response = await axios.get(
      "https://booking-com18.p.rapidapi.com/stays/search",
      {
        params: {
          locationId,
          checkinDate,
          checkoutDate,
          adults: 2,
          page: 1
        },
        headers: {
          "x-rapidapi-key": "4098f9942emsh8142114b8c79580p13fc11jsn00c7d5088160",
          "x-rapidapi-host": "booking-com18.p.rapidapi.com"
        }
      }
    );

    res.json(response.data);

  } catch (error) {
    res.status(500).json({
      error: error.response?.data || error.message
    });
  }
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});