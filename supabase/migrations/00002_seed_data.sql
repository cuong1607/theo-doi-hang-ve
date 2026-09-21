-- ============================================================
-- SEED DATA
-- 5 suppliers + 119 products (dữ liệu thực tế)
-- ============================================================

-- ============================================================
-- SUPPLIERS (5)
-- ============================================================
INSERT INTO public.suppliers (id, code, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'NCC01', 'Bích Đại (Công ty Huy Hoàng)'),
  ('a0000000-0000-0000-0000-000000000002', 'NCC02', 'Vinh Thủy (Nhất Long)'),
  ('a0000000-0000-0000-0000-000000000003', 'NCC03', 'Tuấn Hậu'),
  ('a0000000-0000-0000-0000-000000000004', 'NCC04', 'Minh Hoa'),
  ('a0000000-0000-0000-0000-000000000005', 'NCC05', 'Giang Nhàn');


-- ============================================================
-- PRODUCTS: Bích Đại (Công ty Huy Hoàng) — NCC01
-- ============================================================
INSERT INTO public.products (sku, name, unit, current_price, supplier_id) VALUES
  -- Bao vệ đệm thường
  ('bao_ve_dem_thuong_m2x2m',       'Bao ve dem thuong 1m2x2m',           'chiec', 80000,  'a0000000-0000-0000-0000-000000000001'),
  ('bao_ve_dem_thuong_m4x2m',       'Bao ve dem thuong 1m4x2m',           'chiec', 85000,  'a0000000-0000-0000-0000-000000000001'),
  ('bao_ve_dem_thuong_m6x2m',       'Bao ve dem thuong 1m6x2m',           'chiec', 90000,  'a0000000-0000-0000-0000-000000000001'),
  ('bao_ve_dem_thuong_m8x2m',       'Bao ve dem thuong 1m8x2m',           'chiec', 100000, 'a0000000-0000-0000-0000-000000000001'),
  ('bao_ve_dem_thuong_2mx2m2',      'Bao ve dem thuong 2mx2m2',           'chiec', 115000, 'a0000000-0000-0000-0000-000000000001'),
  -- Bao vệ đệm chống thấm
  ('bao_ve_chong_tham_m2x2m',       'Bao ve dem chong tham 1m2x2m',      'chiec', 95000,  'a0000000-0000-0000-0000-000000000001'),
  ('bao_ve_chong_tham_m4x2m',       'Bao ve dem chong tham 1m4x2m',      'chiec', 105000, 'a0000000-0000-0000-0000-000000000001'),
  ('bao_ve_chong_tham_m6x2m',       'Bao ve dem chong tham 1m6x2m',      'chiec', 115000, 'a0000000-0000-0000-0000-000000000001'),
  ('bao_ve_chong_tham_m8x2m',       'Bao ve dem chong tham 1m8x2m',      'chiec', 125000, 'a0000000-0000-0000-0000-000000000001'),
  ('bao_ve_chong_tham_2mx2m2',      'Bao ve dem chong tham 2mx2m2',      'chiec', 145000, 'a0000000-0000-0000-0000-000000000001'),
  -- Ga chống thấm 10cm
  ('ga_chong_tham_80cmx1m9x10cm',   'Ga chong tham 80cmx190x10cm',       'chiec', 30000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_90cmx1m9x10cm',   'Ga chong tham 90cmx190x10cm',       'chiec', 32000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1mx1m9x10cm',     'Ga chong tham 1mx1m9x10cm',         'chiec', 34000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m2x1m9x10cm',    'Ga chong tham 1m2x1m9x10cm',        'chiec', 37000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m4x1m9x10cm',    'Ga chong tham 1m4x1m9x10cm',        'chiec', 40000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m5x1m9x10cm',    'Ga chong tham 1m5x1m9x10cm',        'chiec', 42000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m6x2mx10cm',     'Ga chong tham 1m6x2mx10cm',         'chiec', 45000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m8x2mx10cm',     'Ga chong tham 1m8x2mx10cm',         'chiec', 48000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_2m2x2mx10cm',     'Ga chong tham 2m2x2mx10cm',         'chiec', 57000,  'a0000000-0000-0000-0000-000000000001'),
  -- Ga chống thấm LX 20cm
  ('ga_chong_tham_1m2x1m9x20cm',    'Ga chong tham LX 1m2x1m9x20cm',    'chiec', 48000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m4x1m9x20cm',    'Ga chong tham LX 1m4x1m9x20cm',    'chiec', 52000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m5x1m9x20cm',    'Ga chong tham LX 1m5x1m9x20cm',    'chiec', 55000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m6x2mx20cm',     'Ga chong tham LX 1m6x2mx20cm',     'chiec', 58000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_1m8x2mx20cm',     'Ga chong tham LX 1m8x2mx20cm',     'chiec', 62000,  'a0000000-0000-0000-0000-000000000001'),
  ('ga_chong_tham_2mx2mx20cm',      'Ga chong tham LX 2mx2mx20cm',      'chiec', 73000,  'a0000000-0000-0000-0000-000000000001'),
  -- Ruột chăn & gối
  ('ruot_chan_dong_2mx2m2',          'Ruot chan dong 2mx2m2 (2.5KG)',     'chiec', 155000, 'a0000000-0000-0000-0000-000000000001'),
  ('ruot_chan_he_2mx2m2',            'Ruot chan he o vuong 2mx2m2',       'chiec', 115000, 'a0000000-0000-0000-0000-000000000001'),
  ('ruot_goi_dau_homies_30cmx45cm', 'Ruot goi trang tre em 30cmx45cm',  'chiec', 15000,  'a0000000-0000-0000-0000-000000000001'),
  ('ruot_goi_dau_homies_45cmx65cm', 'Ruot goi dau 45cmx65cm',           'chiec', 31000,  'a0000000-0000-0000-0000-000000000001'),
  ('ruot_goi_dau_homies_50cmx70cm', 'Ruot goi 50cmx70cm',               'chiec', 40000,  'a0000000-0000-0000-0000-000000000001'),
  ('ruot_goi_om_hoa_tiet_35cmx100cm','Ruot goi om buoc day 35cmx1m',    'chiec', 50000,  'a0000000-0000-0000-0000-000000000001'),
  ('ruot_goi_tua_1_chiec_45cmx45cm','Ruot goi tua 1 chiec 45cmx45cm',   'chiec', 22000,  'a0000000-0000-0000-0000-000000000001');


-- ============================================================
-- PRODUCTS: Vinh Thủy (Nhất Long) — NCC02
-- ============================================================
INSERT INTO public.products (sku, name, unit, current_price, supplier_id) VALUES
  -- Chiếu cài góc
  ('chieu_latex_1m2x2m',            'Chiếu cài góc 1m2x2m',             'chiec', 106000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_latex_1m4x2m',            'Chiếu cài góc 1m4x2m',             'chiec', 114000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_latex_1m5x2m',            'Chiếu cài góc 1m5x2m',             'chiec', 119000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_latex_1m6x2m',            'Chiếu cài góc 1m6x2m',             'chiec', 124000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_latex_1m8x2m',            'Chiếu cài góc 1m8x2m',             'chiec', 135000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_latex_2mx2m2',            'Chiếu cài góc 2mx2m2',             'chiec', 158000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_latex_80cmx1m9',          'Chiếu cài góc 80cmx2m',            'chiec', 85000,  'a0000000-0000-0000-0000-000000000002'),
  -- Chiếu bo chun
  ('chieu_bo_chun_latex_1m2x2m',    'Chiếu bo chun 1m2x2m',             'chiec', 142000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_bo_chun_latex_1m4x2m',    'Chiếu bo chun 1m4x2m',             'chiec', 153000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_bo_chun_latex_1m5x2m',    'Chiếu bo chun 1m5x2m',             'chiec', 158000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_bo_chun_latex_1m6x2m',    'Chiếu bo chun 1m6x2m',             'chiec', 164000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_bo_chun_latex_1m8x2m',    'Chiếu bo chun 1m8x2m',             'chiec', 175000, 'a0000000-0000-0000-0000-000000000002'),
  ('chieu_bo_chun_latex_2mx2m2',    'Chiếu bo chun 2mx2m2',             'chiec', 202000, 'a0000000-0000-0000-0000-000000000002'),
  -- Chăn cừu
  ('chan_tafurong_1m1x1m5',         'Chăn cừu 1m1x2m',                  'chiec', 74000,  'a0000000-0000-0000-0000-000000000002'),
  ('chan_tafurong_1m5x2m1',         'Chăn cừu 1m5x2m',                  'chiec', 129000, 'a0000000-0000-0000-0000-000000000002'),
  ('chan_tafurong_2mx2m3',          'Chăn cừu 2m2x2m',                  'chiec', 158000, 'a0000000-0000-0000-0000-000000000002'),
  -- Thảm lông cừu trải giường
  ('tham_trai_giuong_long_cuu_1m2x1m9', 'Thảm lông cừu 1m2x2m',        'chiec', 116000, 'a0000000-0000-0000-0000-000000000002'),
  ('tham_trai_giuong_long_cuu_1m4x1m9', 'Thảm lông cừu 1m4x2m',        'chiec', 132000, 'a0000000-0000-0000-0000-000000000002'),
  ('tham_trai_giuong_long_cuu_1m5x1m9', 'Thảm lông cừu 1m5x2m',        'chiec', 137000, 'a0000000-0000-0000-0000-000000000002'),
  ('tham_trai_giuong_long_cuu_1m6x2m',  'Thảm lông cừu 1m6x2m',        'chiec', 142000, 'a0000000-0000-0000-0000-000000000002'),
  ('tham_trai_giuong_long_cuu_1m8x2m',  'Thảm lông cừu 1m8x2m',        'chiec', 153000, 'a0000000-0000-0000-0000-000000000002'),
  ('tham_trai_giuong_long_cuu_2mx2m2',  'Thảm lông cừu 2m2x2m',        'chiec', 188000, 'a0000000-0000-0000-0000-000000000002'),
  ('tham_trai_giuong_long_cuu_80cmx1m9','Thảm lông cừu 0.8cmx2m',      'chiec', 90000,  'a0000000-0000-0000-0000-000000000002'),
  -- Vỏ gối & Chăn lông sữa
  ('vo_goi_long_cuu_45cmx65cm',     'Vỏ Gối Lông Cừu 45cmx65cm',       'chiec', 30000,  'a0000000-0000-0000-0000-000000000002'),
  ('vo_goi_dieu_hoa_latex_45cmx65cm','Vỏ Gối Điều Hòa Latex 45cmx65cm','chiec', 14500,  'a0000000-0000-0000-0000-000000000002'),
  ('chan_long_sua',                  'Chăn Lông Sữa Mùa Đông',           'chiec', 240000, 'a0000000-0000-0000-0000-000000000002'),
  -- Set thảm trải giường bo chun
  ('set_tham_trai_giuong_bo_chun_1m6x2m', 'Set Thảm trải giường bo chun 1m6x2m', 'chiec', 110000, 'a0000000-0000-0000-0000-000000000002'),
  ('set_tham_trai_giuong_bo_chun_1m8x2m', 'Set Thảm trải giường bo chun 1m8x2m', 'chiec', 125000, 'a0000000-0000-0000-0000-000000000002'),
  ('set_tham_trai_giuong_bo_chun_2mx2m2', 'Set Thảm trải giường bo chun 2mx2m2',  'chiec', 140000, 'a0000000-0000-0000-0000-000000000002');


-- ============================================================
-- PRODUCTS: Tuấn Hậu — NCC03
-- ============================================================
INSERT INTO public.products (sku, name, unit, current_price, supplier_id) VALUES
  -- Thảm nỉ (Bali)
  ('tham_bali_trai_san_1m2x1m6',    'Thảm nỉ trải sàn (1m2*1m6)',           'chiec', 90000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_tron_1m2x1m2',        'Thảm nỉ trải sàn tròn (120cm*120cm)',   'chiec', 70000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_may_giat_bali_50cmx60cm','Thảm nỉ máy giặt (50cm*60cm)',        'chiec', 14000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_may_giat_bali_60cmx60cm','Thảm nỉ máy giặt (60cm*60cm)',        'chiec', 18000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_ve_sinh_chu_u_55cmx60cm',   'Thảm Vệ Sinh Chữ U 55cmx60cm',        'chiec', 14500,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_ve_sinh_chu_u_60cmx90cm',   'Thảm Vệ Sinh Chữ U 60cmx90cm',        'chiec', 25000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_ly_bali_40cmx50cm',     'Thảm nỉ lót ly (40cm * 50cm)',         'chiec', 7800,   'a0000000-0000-0000-0000-000000000003'),
  ('tham_ghe_bali_tam_dai_2mx50cm',  'THẢM NỈ TRẢI GHẾ (50CM*200CM)',        'chiec', 52000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_trai_san_80cmx2m',     'Thảm nỉ đầu giường (80cm * 200cm)',    'chiec', 80000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_tron_80cmx80cm',       'Thảm nỉ trải sàn tròn (80cm * 80cm)',  'chiec', 32000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_trai_san_1m6x2m3',     'Thảm nỉ trải sàn (160cm * 230cm)',     'chiec', 145000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_chui_chan_60cmx90cm',   'Thảm nỉ trải sàn (60cm * 90cm)',       'chiec', 25000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_ly_bali_30cmx40cm',     'Thảm nỉ lót ly (30cm * 40cm)',         'chiec', 6500,   'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_trai_san_2mx3m',       'Thảm nỉ trải sàn (200cm * 300cm)',     'chiec', 245000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_tron_1mx1m',           'Thảm nỉ trải sàn tròn (100cm * 100cm)','chiec', 50000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_chui_chan_50cmx70cm',   'Thảm nỉ trải sàn (50cm * 70cm)',       'chiec', 16000,  'a0000000-0000-0000-0000-000000000003'),
  ('bo_2_tham_bep_bali_50cmx70cm',   'Thảm nỉ trải bếp 2 tấm (50cm * 150cm - 50cm * 70cm)', 'chiec', 50000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_tron_1m6x1m6',        'Thảm nỉ trải sàn tròn (160cm * 160cm)','chiec', 120000, 'a0000000-0000-0000-0000-000000000003'),
  ('bo_2_tham_bep_bali',            'Thảm nỉ trải bếp 2 tấm (40cm * 120cm - 40cm*60cm)', 'chiec', 27000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_trai_san_80cmx1m5',   'Thảm nỉ trải sàn (80cm * 150cm)',       'chiec', 75000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_chui_chan_40cmx60cm',  'Thảm nỉ trải sàn (40cm * 60cm)',        'chiec', 8000,   'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_tron_60cmx60cm',      'Thảm nỉ trải sàn tròn (60cm * 60cm)',   'chiec', 18000,  'a0000000-0000-0000-0000-000000000003'),
  ('bo_2_tham_bep_bali_60cmx1m',    'THẢM NỈ TRẢI BẾP 2 TẤM (60CM * 100 - 60CM*200CM)', 'chiec', 81000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_ghe_bali_tam_ngan_50cmx50cm','THẢM NỈ TRẢI GHẾ (50CM*50CM)',        'chiec', 15000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_ghe_bali_tam_dai_1m8x50cm','THẢM NỈ TRẢI GHẾ (50CM * 180CM)',       'chiec', 52000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_may_giat_bali_50cmx50cm','Thảm nỉ máy giặt (50cm * 50cm)',      'chiec', 12000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_bet_bali_40cmx40cm',       'Thảm nỉ tròn (40cm * 40cm)',            'chiec', 6500,   'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_trai_san_80cmx1m6',   'Thảm nỉ trải sàn (80cm * 160cm)',       'chiec', 75000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_trai_san_1m4x2m',     'Thảm nỉ trải sàn (140cm * 200cm)',      'chiec', 130000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_bali_trai_san_1mx1m5',     'Thảm nỉ trải sàn tròn (100cm * 150cm)', 'chiec', 80000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_ghe_bali_tam_dai_1m7x50cm','Thảm nỉ trải ghế (50cm*170cm)',         'chiec', 52000,  'a0000000-0000-0000-0000-000000000003'),
  -- Thảm lông cừu (Tuấn Hậu)
  ('tham_long_cuu_tron_40cmx40cm',  'Thảm lông trải sàn (40cm * 40cm)',      'chiec', 18000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_tron_1mx1m',      'Thảm lông trải sàn tròn (100cm * 100cm)','chiec', 115000,'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_1m4x2m',         'Thảm lông trải sàn (140cm * 200cm)',     'chiec', 320000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_50cmx1m2',       'Thảm lông trải sàn (50cm * 120cm)',      'chiec', 72000,  'a0000000-0000-0000-0000-000000000003'),
  ('bo_2_tham_bep_long_cuu',       'Thảm lông trải bếp 2 tấm (40cm * 120cm - 40cm * 60cm)', 'chiec', 76000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_50cmx70cm',      'Thảm lông trải sàn (50cm * 70cm)',       'chiec', 39000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_1m6x2m3',        'Thảm lông trải sàn (160cm * 230cm)',     'chiec', 385000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_40cmx60cm',      'Thảm lông trải sàn (40cm * 60cm)',       'chiec', 21000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_tron_60cmx60cm', 'Thảm lông trải sàn tròn (60cm * 60cm)',  'chiec', 41000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_tron_1m2x1m2',   'Thảm lông trải sàn tròn (120cm * 120cm)','chiec', 170000,'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_tron_1m6x1m6',   'Thảm lông trải sàn (160cm * 160cm)',     'chiec', 295000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_1m2x1m6',        'Thảm lông trải sàn (120cm * 160cm)',     'chiec', 220000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_60cmx90cm',      'Thảm lông trải sàn (60cm * 90cm)',       'chiec', 72000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_long_cuu_80cmx2m',        'Thảm lông trải sàn (80cm * 200cm)',      'chiec', 190000, 'a0000000-0000-0000-0000-000000000003'),
  -- Thảm silicon (Tuấn Hậu)
  ('tham_lot_may_giat_silicon_50cmx60cm', 'Thảm silicon máy giặt (50cm * 60cm)',  'chiec', 32000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_ly_silicon_40cmx50cm',       'Thảm silicon lót ly (40cm * 50cm)',    'chiec', 21000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_silicon_80cmx1m2',               'Thảm silicon trải sàn (80cm * 120cm)', 'chiec', 105000,'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_may_giat_silicon_60cmx60cm', 'Thảm silicon máy giặt (60cm * 60cm)',  'chiec', 39000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_ly_silicon_30cmx40cm',       'Thảm silicon lót ly (30cm * 40cm)',    'chiec', 13000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_silicon_40cmx60cm',              'Thảm silicon trải sàn (40cm * 60cm)',  'chiec', 19000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_silicon_60cmx90cm',              'Thảm silicon trải sàn (60cm * 90cm)',  'chiec', 58000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_silicon_tron_60cmx60cm',         'Thảm silicon trải sàn tròn (60cm * 60cm)', 'chiec', 41000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_silicon_tron_1mx1m',             'Thảm silicon trải sàn tròn (100cm * 100cm)','chiec', 115000,'a0000000-0000-0000-0000-000000000003'),
  ('tham_silicon_tron_40cmx40cm',         'Thảm silicon tròn (40cm * 40cm)',      'chiec', 18000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_coc_silicon_10cmx10cm',      'Thảm silicon lót ly (10cm * 10cm)',    'chiec', 4000,  'a0000000-0000-0000-0000-000000000003'),
  ('tham_lot_may_giat_silicon_50cmx50cm', 'Thảm silicon máy giặt (50cm * 50cm)',  'chiec', 26500, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_silicon_50cmx70cm',              'Thảm silicon trải sàn (50cm * 70cm)',  'chiec', 39000, 'a0000000-0000-0000-0000-000000000003'),
  ('bo_2_tham_bep_silicon',               'Thảm silicon trải bếp 2 tấm (40cm * 60cm - 40cm*120cm)', 'chiec', 70000, 'a0000000-0000-0000-0000-000000000003'),
  ('tham_silicon_80cmx2m',                'Thảm silicon trải sàn (80cm * 200cm)', 'chiec', 180000,'a0000000-0000-0000-0000-000000000003'),
  ('tham_bep_chu_l_silicon',              'Thảm Bếp Chữ L Silicon',              'chiec', 95000, 'a0000000-0000-0000-0000-000000000003');


-- ============================================================
-- PRODUCTS: Minh Hoa — NCC04
-- ============================================================
INSERT INTO public.products (sku, name, unit, current_price, supplier_id) VALUES
  -- Nệm Topper
  ('nem_topper_90cmx1m9',           'Nệm Topper 90cmx1m9',              'chiec', 160000, 'a0000000-0000-0000-0000-000000000004'),
  ('nem_topper_1mx1m9',             'Nệm Topper 1mx1m9',                'chiec', 160000, 'a0000000-0000-0000-0000-000000000004'),
  ('nem_topper_1m2x1m9',            'Nệm Topper 1m2x1m9',               'chiec', 170000, 'a0000000-0000-0000-0000-000000000004'),
  ('nem_topper_1m6x2m',             'Nệm Topper 1m6x2m',                'chiec', 200000, 'a0000000-0000-0000-0000-000000000004'),
  ('nem_topper_1m8x2m',             'Nệm Topper 1m8x2m',                'chiec', 220000, 'a0000000-0000-0000-0000-000000000004'),
  ('nem_topper_2mx2m2',             'Nệm Topper 2mx2m2',                'chiec', 250000, 'a0000000-0000-0000-0000-000000000004'),
  -- Vỏ bọc Topper
  ('vo_boc_topper_90cmx1m9',        'Vỏ Bọc Topper 90cmx1m9',           'chiec', 45000,  'a0000000-0000-0000-0000-000000000004'),
  ('vo_boc_topper_1m2x1m9',         'Vỏ Bọc Topper 1m2x1m9',            'chiec', 50000,  'a0000000-0000-0000-0000-000000000004'),
  ('vo_boc_topper_1m6x2m_1m5x1m9',  'Vỏ Bọc Topper 1m6x2m ( 1m5x1m9 )','chiec', 65000,  'a0000000-0000-0000-0000-000000000004'),
  ('vo_boc_topper_1m8x2m',          'Vỏ Bọc Topper 1m8x2m',             'chiec', 75000,  'a0000000-0000-0000-0000-000000000004'),
  ('vo_boc_topper_1mx1m9',          'Vỏ Bọc Topper 1mx1m9',             'chiec', 45000,  'a0000000-0000-0000-0000-000000000004'),
  ('vo_boc_topper_2mx2m2',          'Vỏ Bọc Topper 2mx2m2',             'chiec', 90000,  'a0000000-0000-0000-0000-000000000004');


-- ============================================================
-- PRODUCTS: Giang Nhàn — NCC05
-- ============================================================
INSERT INTO public.products (sku, name, unit, current_price, supplier_id) VALUES
  ('ghe_tatami_tron',               'Ghế Tatami Trơn',                   'chiec', 180000, 'a0000000-0000-0000-0000-000000000005'),
  ('ghe_tatami_hoa_tiet',           'Ghế Tatami Hoa Tiết',               'chiec', 200000, 'a0000000-0000-0000-0000-000000000005'),
  ('goi_tua_lung_tatami',           'Gối tựa lưng TATAMI',               'chiec', 18000,  'a0000000-0000-0000-0000-000000000005'),
  ('dem_bet_dui_40cmx40cm',         'Đệm Bệt Đũi 40cmx40cm',            'chiec', 24000,  'a0000000-0000-0000-0000-000000000005'),
  ('dem_bet_nhung_40cmx40cm',       'Đệm Bệt Nhung 40cmx40cm',          'chiec', 30000,  'a0000000-0000-0000-0000-000000000005'),
  ('dem_bet_bi_thuong',             'Đệm Bệt Bí Thường',                'chiec', 45000,  'a0000000-0000-0000-0000-000000000005'),
  ('dem_bet_hoa',                   'Đệm bệt hoa',                      'chiec', 45000,  'a0000000-0000-0000-0000-000000000005');
