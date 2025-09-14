const ee = require('@google/earthengine');

// Main serverless function handler
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow requests from any origin
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        if (!process.env.GEE_PRIVATE_KEY) {
            throw new Error('Server config error: GEE_PRIVATE_KEY not set.');
        }
        const privateKey = JSON.parse(process.env.GEE_PRIVATE_KEY);
        const lat = parseFloat(req.query.lat);
        const lon = parseFloat(req.query.lon);

        if (isNaN(lat) || isNaN(lon)) {
            return res.status(400).json({ error: 'Invalid coordinates.' });
        }

        await authenticate(privateKey);
        const data = await runAnalysis(lat, lon);
        
        res.status(200).json(data);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
};

// GEE Authentication (Promisified)
const authenticate = (privateKey) => new Promise((resolve, reject) => {
    ee.data.authenticateViaPrivateKey(privateKey, 
        () => ee.initialize(null, null, resolve, reject),
        (e) => reject(`GEE Authentication failed: ${e}`)
    );
});

// GEE Analysis (Promisified)
const runAnalysis = (lat, lon) => new Promise((resolve, reject) => {
    const aoi = ee.Geometry.Point([lon, lat]);
    const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED');

    const filtered = s2
        .filterBounds(aoi)
        .filterDate(ee.Date(Date.now()).advance(-120, 'day'), ee.Date(Date.now()))
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10));

    const recentImage = filtered.sort('system:time_start', false).first();

    recentImage.get('system:index').evaluate((id, error) => {
        if (error || !id) {
            return reject('No recent cloud-free image found.');
        }
        const ndvi = recentImage.normalizedDifference(['B8', 'B4']).rename('NDVI');
        const date = ee.Date(recentImage.get('system:time_start')).format('YYYY-MM-dd');
        const ndviValue = ndvi.reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: aoi,
            scale: 10
        }).get('NDVI');
        
        ee.Dictionary({ date, ndvi: ndviValue }).evaluate((result, err) => {
            if (err) reject(`GEE Evaluation Error: ${err}`);
            else if (result.ndvi === null) reject('Point is likely in water or has no data.');
            else resolve(result);
        });
    });
});

