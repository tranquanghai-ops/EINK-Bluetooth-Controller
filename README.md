# EINK Bluetooth Controller

Trang điều khiển Web Bluetooth dành cho màn hình E-Ink 2,13 inch 250×128, hỗ trợ hai nhóm thiết bị:

- **DA14585 Legacy**: tự nhận dạng serial service và e-paper service cũ.
- **nRF52 model 2**: nhận model, mode và MTU từ phản hồi của firmware.

## Điểm chính

- Tự nhận dạng giao thức sau khi kết nối.
- Chỉ hiển thị nút tương thích với thiết bị đang sử dụng.
- Đồng bộ ngày giờ và chuyển chế độ lịch/đồng hồ/ảnh.
- Truyền ảnh 250×128 với xử lý ba màu đen–trắng–đỏ ngay trên trình duyệt.
- Hiệu chỉnh DA14585 được đặt trong khu vực nâng cao và kiểm tra giá trị HEX.
- Nhật ký kết nối rõ ràng, thuận tiện chẩn đoán lỗi.
- Không tải ảnh của người dùng lên máy chủ.

## Trình duyệt

Sử dụng **Google Chrome** hoặc **Microsoft Edge** trên máy tính/Android. Web Bluetooth cần HTTPS; GitHub Pages đáp ứng yêu cầu này.

## Xuất bản GitHub Pages

Repository có workflow tự động triển khai. Trong GitHub, vào **Settings → Pages → Source** và chọn **GitHub Actions** nếu Pages chưa được bật.

## Thiết bị đã kiểm tra giao thức

| Nhóm | Dấu hiệu nhận dạng |
|---|---|
| DA14585 Legacy | `rxtxService`, `epdService`, `epdCharacteristic` |
| nRF52 model 2 | nRF52 service, phản hồi `model 2`, `mode`, `mtu` |

> Lưu ý: không ghi firmware giữa DA14585 và nRF52. Hai nền tảng không tương thích.
