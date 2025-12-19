const map = L.map('map').setView([46.603354, 1.888334], 6); // Centré sur la France

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

let markers = [];
let circle = null;
let polylines = [];

let cityCount = 3;

function addCityInput() {
    cityCount++;
    const container = document.getElementById('citiesContainer');
    const div = document.createElement('div');
    div.className = 'form-group';
    div.innerHTML = `
        <label for="city${cityCount}">Ville #${cityCount}</label>
        <input type="text" id="city${cityCount}" class="city-input" placeholder="Ex: Ville ${cityCount}" required>
        <button type="button" class="remove-city" onclick="this.parentElement.remove()">Supprimer</button>
    `;
    container.appendChild(div);
}

document.getElementById('addCityBtn').addEventListener('click', addCityInput);

// Force la carte à se redimensionner correctement, surtout sur mobile
function refreshMap() {
    setTimeout(() => {
        map.invalidateSize();
    }, 300); // Augmentation du délai pour s'assurer que le layout CSS est stabilisé
}

window.addEventListener('resize', refreshMap);
window.addEventListener('load', refreshMap);

function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours} h ${minutes} min`;
    }
    return `${minutes} min`;
}

async function getCoordinates(city) {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`);
    const data = await response.json();
    if (data && data.length > 0) {
        return {
            lat: parseFloat(data[0].lat),
            lon: parseFloat(data[0].lon),
            name: data[0].display_name
        };
    }
    throw new Error(`Ville non trouvée : ${city}`);
}

async function getTravelDuration(from, to) {
    // Ajout d'une petite pause pour respecter le rate limit potentiel de l'API publique OSRM
    await new Promise(resolve => setTimeout(resolve, 100));
    // OSRM API expects lon,lat
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.code === 'Ok') {
        return data.routes[0].duration; // en secondes
    }
    return Infinity;
}

async function getRouteGeometry(from, to) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.code === 'Ok') {
        return data.routes[0].geometry.coordinates.map(coord => [coord[1], coord[0]]); // [lat, lon] pour Leaflet
    }
    return null;
}

async function findOptimalCenter(cityCoords) {
    // Départ du barycentre géographique
    let currentCenter = {
        lat: cityCoords.reduce((sum, c) => sum + c.lat, 0) / cityCoords.length,
        lon: cityCoords.reduce((sum, c) => sum + c.lon, 0) / cityCoords.length
    };

    const loadingText = document.getElementById('loadingText');

    // Recherche par grille pour affiner (approche simplifiée pour SPA)
    // On teste autour du centre actuel avec un pas décroissant
    let bestCenter = currentCenter;
    let minTotalTime;

    async function evaluate(point, updateLoading = false) {
        if (updateLoading) {
            loadingText.textContent = `Évaluation du point (${point.lat.toFixed(2)}, ${point.lon.toFixed(2)})...`;
        }
        const times = await Promise.all(cityCoords.map(c => getTravelDuration(c, point)));
        return times.reduce((a, b) => a + b, 0);
    }

    // On fait quelques itérations de recherche locale
    minTotalTime = await evaluate(currentCenter, true);

    // Pas de recherche : ~10km, puis ~2km
    const steps = [0.1, 0.02];
    for (let step of steps) {
        let foundBetter = true;
        let iterations = 0;
        while (foundBetter && iterations < 5) { // Limitation du nombre d'itérations pour la réactivité
            iterations++;
            foundBetter = false;
            const candidates = [
                { lat: bestCenter.lat + step, lon: bestCenter.lon },
                { lat: bestCenter.lat - step, lon: bestCenter.lon },
                { lat: bestCenter.lat, lon: bestCenter.lon + step },
                { lat: bestCenter.lat, lon: bestCenter.lon - step }
            ];

            for (let cand of candidates) {
                const time = await evaluate(cand, true);
                if (time < minTotalTime) {
                    minTotalTime = time;
                    bestCenter = cand;
                    foundBetter = true;
                }
            }
        }
    }

    const finalTimes = await Promise.all(cityCoords.map(c => getTravelDuration(c, bestCenter)));
    return {
        ...bestCenter,
        times: finalTimes
    };
}

document.getElementById('cityForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = document.getElementById('submitBtn');
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');

    submitBtn.disabled = true;
    loading.style.display = 'block';
    loadingText.textContent = "Calcul de l'itinéraire optimal...";

    // Nettoyage précédent
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    polylines.forEach(p => map.removeLayer(p));
    polylines = [];
    if (circle) map.removeLayer(circle);

    const cities = Array.from(document.querySelectorAll('.city-input'))
        .map(input => input.value.trim())
        .filter(value => value !== "");

    if (cities.length < 2) {
        alert("Veuillez saisir au moins deux villes.");
        loading.style.display = 'none';
        return;
    }

    try {
        const coords = await Promise.all(cities.map(getCoordinates));

        const optimalCenter = await findOptimalCenter(coords);

        loadingText.textContent = "Tracé des itinéraires...";
        const routeGeometries = await Promise.all(coords.map(c => getRouteGeometry(c, optimalCenter)));

        coords.forEach((c, i) => {
            const durationStr = formatDuration(optimalCenter.times[i]);
            const marker = L.marker([c.lat, c.lon])
                .addTo(map)
                .bindPopup(`${c.name}<br>Temps vers centre : ${durationStr}`);
            markers.push(marker);

            if (routeGeometries[i]) {
                const polyline = L.polyline(routeGeometries[i], {
                    color: '#3498db',
                    weight: 4,
                    opacity: 0.6,
                    dashArray: '10, 10'
                }).addTo(map);
                polylines.push(polyline);
            }
        });

        circle = L.circle([optimalCenter.lat, optimalCenter.lon], {
            color: 'green',
            colorOpacity: 0.5,
            fillColor: '#0f8e00',
            fillOpacity: 0.1,
            radius: 50000 // 50 km en mètres
        }).addTo(map);

        const avgTime = optimalCenter.times.reduce((a, b) => a + b, 0) / coords.length;
        const avgTimeStr = formatDuration(avgTime);
        circle.bindPopup(`Centre optimal (Temps moyen: ${avgTimeStr})`).openPopup();

        const group = new L.featureGroup([...markers, ...polylines, circle]);
        map.fitBounds(group.getBounds());

    } catch (error) {
        console.error(error);
        alert(error.message);
    } finally {
        submitBtn.disabled = false;
        loading.style.display = 'none';
        loadingText.textContent = "Recherche des coordonnées...";
    }
});
