#include <stdio.h>

int main()
{
    // 表示するメッセージを変数に格納
    int age = 20;
    float pi_float = 3.14;
    double pi_double = 3.14159;
    char letter = 'A';
    char message[] = "Hello, World!";

    // メッセージと数値を表示
    printf("%s\n", message);    //char配列を表示
    printf("Welcome to C programming!\n");

    /*
        printf("This Line is not executed!\n");
    */

    /* printf("This Line is not executed!!\n"); */

    return 0;
}