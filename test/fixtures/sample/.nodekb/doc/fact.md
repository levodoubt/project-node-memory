<node name="fact:abi" type="fact">
ABI 稳定：结构体布局不随版本变化，新增字段只能加在末尾。
</node>

<node name="fact:abi-trap" type="fact" parent="fact:abi">
坑：不要按字节拷贝结构体；溯源见 [[fact:abi]] 本身。
</node>
