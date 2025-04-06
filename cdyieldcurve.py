import requests
import pandas as pd
import datetime
import time
import os

# 目标 URL
url = 'https://yield.chinabond.com.cn/cbweb-mn/yc/searchYc'

# POST 请求需要的数据模板
data_template = {
    'xyzSelect': 'txy',
    'dxbj': 0,
    'qxll': '0,',
    'yqqxN': 'N',
    'yqqxK': 'K',
    'ycDefIds': '8308218CA7F40E0DE0540010E03EE6DA',
    'wrjxCBFlag': 0,
    'locale': 'zh_CN'
}

# 指定文件保存的目录和文件名
file_path = 'D:\\zencode\\yield_curve_data.xlsx'

# 遍历日期
start_date = datetime.datetime(2024, 1, 1)
end_date = datetime.datetime(2024, 4, 30)

# 初始化一个空列表来收集所有数据
all_data_list = []

# 遍历日期
current_date = start_date
while current_date <= end_date:
    # 更新 workTimes
    data_template['workTimes'] = current_date.strftime('%Y-%m-%d')
    
    # 发送 POST 请求
    try:
        response = requests.post(url, data=data_template)
        response.raise_for_status()  # 检查请求是否成功
        json_data = response.json()
        
        for item in json_data:
            new_data = {
                'ycDefId': item['ycDefId'],
                'ycDefName': item['ycDefName'],
                'worktime': current_date.strftime('%Y-%m-%d')
            }
            for time_value, yield_value in item['seriesData']:
                column_name = f'Time_{time_value:.3f}'
                new_data[column_name] = yield_value
            all_data_list.append(new_data)
    
    except requests.exceptions.RequestException as e:
        print(f"Error fetching data for {current_date.strftime('%Y-%m-%d')}: {e}")
        # 等待一段时间再重试
        time.sleep(5)
    
    # 更新日期
    current_date += datetime.timedelta(days=1)

# 将收集的数据列表转换为 DataFrame
new_data_df = pd.DataFrame(all_data_list)

# 检查文件是否存在
if os.path.exists(file_path):
    # 读取现有的 Excel 文件数据
    existing_data_df = pd.read_excel(file_path)
    
    # 排除空的或全为NA的DataFrame
    frames = [df for df in [existing_data_df, new_data_df] if not df.empty and not df.isna().all().all()]

    if frames:
        combined_data_df = pd.concat(frames).drop_duplicates().reset_index(drop=True)
    else:
        combined_data_df = pd.DataFrame()
else:
    # 如果文件不存在，则新数据即为合并后的数据
    combined_data_df = new_data_df if not new_data_df.empty and not new_data_df.isna().all().all() else pd.DataFrame()

# 保存所有数据到 Excel 文件
combined_data_df.to_excel(file_path, index=False)

print('已完成')