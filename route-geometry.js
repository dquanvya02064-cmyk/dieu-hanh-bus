function normalizeRouteGeometry(coordinates) {
  if (!Array.isArray(coordinates)) throw new Error('Geometry tuyến phải là danh sách tọa độ.');
  if (coordinates.length > 5000) throw new Error('Mỗi chiều tuyến tối đa 5.000 điểm hình học.');
  return coordinates.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new Error(`Tọa độ hình học thứ ${index + 1} không hợp lệ.`);
    }
    const longitude = Number(point[0]);
    const latitude = Number(point[1]);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error(`Tọa độ hình học thứ ${index + 1} nằm ngoài phạm vi.`);
    }
    return [longitude, latitude];
  });
}

function calculatePolylineDistance(coordinates) {
  const earthRadiusMeters = 6371008.8;
  let distance = 0;
  for (let index = 1; index < coordinates.length; index++) {
    const [[longitudeA, latitudeA], [longitudeB, latitudeB]] = [coordinates[index - 1], coordinates[index]];
    const radians = degrees => degrees * Math.PI / 180;
    const deltaLatitude = radians(latitudeB - latitudeA);
    const deltaLongitude = radians(longitudeB - longitudeA);
    const a = Math.sin(deltaLatitude / 2) ** 2 +
      Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(deltaLongitude / 2) ** 2;
    distance += 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return distance;
}

function splitRouteWaypoints(waypoints) {
  const batches = [];
  for (let start = 0; start < waypoints.length - 1; start += 99) {
    batches.push(waypoints.slice(start, start + 100));
  }
  return batches;
}

function combineRouteSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) {
    throw new Error('Cần có ít nhất một đoạn đường để ghép.');
  }
  return normalizeRouteGeometry(segments.flatMap((segment, index) =>
    index ? segment.slice(1) : segment
  ));
}

module.exports = { calculatePolylineDistance, combineRouteSegments, normalizeRouteGeometry, splitRouteWaypoints };