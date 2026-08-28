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
- Nhật ký kết nối kèm danh sách GATT service/characteristic và xuất tệp JSON chẩn đoán.
- Mã hóa ảnh DA14585 Legacy 250×128 theo đúng thứ tự cột và quy ước điểm ảnh của công cụ gốc.
- Các lệnh E3/E4/E5 chưa được firmware xác nhận được đưa vào khu vực thử nghiệm.
- Tự phát hiện dịch vụ Telink OTA 0x221F/0x331F; chỉ khi có dịch vụ này mới cho kiểm tra đọc và sao lưu vùng firmware 0x20000–0x3FFFF.
- Không tải ảnh hoặc firmware của người dùng lên máy chủ.

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


## An toàn khi sao lưu firmware

Ứng dụng không gửi lệnh đọc Flash khi vừa kết nối. Khu vực sao lưu chỉ xuất hiện nếu thiết bị công bố đồng thời service `0000221f-...` và characteristic `0000331f-...`. Người dùng phải chạy kiểm tra đọc thành công trước khi nút tải bản sao được bật. Luồng này chỉ dùng lệnh đọc `0x04`; ứng dụng không triển khai lệnh xóa, ghi hoặc hoàn tất OTA.

> Bản sao firmware của một thiết bị không nên nạp sang thiết bị khác nếu chưa xác nhận cùng chip, Flash layout, màn hình và bootloader.
